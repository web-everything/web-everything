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
 * SECURITY: the workflow runs THIS script from `main` (never the PR's ref), so a PR cannot neuter the gate's
 * SCRIPTS. It can still edit the workflow YAML itself (GitHub reads that from the PR's merge ref / the group
 * commit), so the defence there is review escalation of any `.github/workflows/*` diff — pinned by a test — not
 * this script. The PR's body/labels/diff are read as DATA only.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluatePrGates, evaluateGroup, groupMembership, prNumberOfSubject, formatPrResult } from './lib/merge-gate-ci.mjs';
import { readDrainAcceptance, computeNetDiffSignals } from './merge-ai-prs.mjs';
import { extractManifestFromBody } from './readiness/lane-manifest.mjs';
import { remoteManifestApiArgs } from './lib/remote-manifest.mjs';
import { findDuplicateIds } from './lib/duplicate-id-tripwire.mjs';
import { loadDrainGateSettings } from './lib/codeql-gate.mjs';
import { loadMergeDeliveryPolicy, formatMergeDeliverySourcesLine } from './lib/merge-delivery-policy.mjs';
import { readSettings, readDeclaredSettings } from './lib/settings-files.mjs';
import { GATE_IDS } from './lib/merge-gate-inventory.mjs';
import { REVIEW_AUTHORITIES } from './lib/pr-merge-gate.mjs';
import { writeAllSync } from './lib/write-all-sync.mjs';
import { readSharedFreeze } from './lib/red-main-freeze-shared.mjs';

const firstLine = (e) => String(e?.stderr || e?.message || e).trim().split('\n').pop().slice(0, 300);
const ghJson = (args, exec) => JSON.parse(exec('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }) || 'null');

const PR_FIELDS = 'number,title,body,labels,commits,headRefName,headRefOid,baseRefName,statusCheckRollup';
const BODY_HISTORY_QUERY = 'query($o:String!,$n:String!,$pr:Int!){repository(owner:$o,name:$n){pullRequest(number:$pr){userContentEdits(first:100){totalCount nodes{diff}}}}}';
const QUEUE_QUERY = 'query($o:String!,$n:String!,$b:String!){repository(owner:$o,name:$n){mergeQueue(branch:$b){entries(first:100){nodes{position headCommit{oid} pullRequest{number}}}}}}';

/**
 * The configured `mergeGate.reviewAuthority` as the `ledger` gate's fact. `authority` is passed through verbatim
 * (an unknown value is read as the stricter `both` by `decideLedgerGate`, never as `labels`); an unset one is the
 * drain's own default. Any problem reading the settings files is an `error` → the gate fails closed, because a
 * skipped settings file could be the one that carried the stricter authority. Never throws.
 */
export function readLedgerConfig(read = readDeclaredSettings) {
  // SINGLE SOURCE: the declared settings files (`scripts/dispatch-settings.json` + `scripts/settings/*.json`, key
  // `mergeGate.reviewAuthority`) — the same layer `loadMergeDeliveryPolicy` reads. `config/platformDefaults.ts`
  // only declares the default; nothing on the live path reads it, so it is not a second source here.
  try {
    const { settings, errors, duplicates } = read();
    if (errors?.length) return { error: errors.map((e) => `${e.source}: ${e.error}`).join('; ').slice(0, 300) };
    // Two files setting the same key would silently let the last one win.
    const dup = (duplicates || []).find((d) => /^mergeGate(\.|$)/.test(String(d?.path)));
    if (dup) return { error: `mergeGate set by more than one settings file (${(dup.sources || []).join(', ')})` };
    const block = settings?.mergeGate;
    if (block !== undefined && (block === null || typeof block !== 'object' || Array.isArray(block))) return { error: 'mergeGate settings block is not an object' };
    const authority = block?.reviewAuthority;
    // Strict allow-list: an explicit null / non-string / unknown value must not silently become `labels`.
    if (authority !== undefined && !REVIEW_AUTHORITIES.includes(authority)) return { error: `unknown mergeGate.reviewAuthority ${JSON.stringify(authority)}` };
    return { authority };
  } catch (e) { return { error: firstLine(e) }; }
}

/** Gather every fact `evaluatePrGates` needs for one PR. Never throws; each failure is recorded on its fact. */
export function gatherPrFacts({ repo, num, cwd, defaultBranch, groupDuplicateIds = null, ledgerConfig = null, redMain = null, exec = execFileSync }) {
  const facts = { repo, num };
  // Ledger authority: gathered FIRST, so even a PR-read failure below carries the configured authority. A caller
  // that supplies no `ledgerConfig` gets an error (fail closed), never a silent `labels`. The ledger evidence
  // itself (folded/derived) is not wired yet → null, which `ledger`/`both` defer (fail closed).
  facts.ledger = ledgerConfig ? { ...ledgerConfig, folded: null, derived: null } : { error: 'ledgerConfig not supplied', folded: null, derived: null };
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
      const nodes = Array.isArray(edits.nodes) ? edits.nodes : [];
      const bodies = [pr.body || '', ...nodes.map((x) => x?.diff).filter((x) => typeof x === 'string')];
      // `diff` is nullable (a deleted/redacted edit): a node we could not read is a version we never saw, so the
      // history is complete only when every counted edit was returned AND carried a readable body.
      facts.bodyHistory = { bodies, complete: Array.isArray(edits.nodes) && edits.totalCount <= nodes.length && nodes.every((x) => typeof x?.diff === 'string') };
    }
  } catch (e) { facts.bodyHistory = { error: firstLine(e) }; }

  // Duplicate ids on main (the checkout this script runs from) and, for a merge group, the group's tree.
  const scan = (dir) => (existsSync(dir) ? findDuplicateIds(dir) : null);
  const mainDup = scan(join(cwd, 'backlog'));
  facts.duplicateIds = mainDup === null ? { error: `no backlog dir at ${cwd}` } : { main: mainDup, ...(groupDuplicateIds ? { group: groupDuplicateIds } : {}) };

  // Red-main freeze: the SHARED copy on the ops branch (xyd06qo), read once per run by the caller. Not passed, or
  // unreadable → `{source:null}` / `{error}` → the evaluator fails closed.
  facts.redMain = redMain ?? { source: null };
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

/**
 * The PR numbers in a merge group AND whether that list is provably complete (`groupMembership`). The queue API is
 * supplemental (it can only add PRs); the first-parent history is the cross-check — it must be readable and every
 * commit in it must map to a PR, else `complete` is false and BOTH callers (`--list-group`, the group verdict)
 * fail closed: a partial list would let the unlisted PRs merge unevaluated.
 * @returns {{nums:number[], complete:boolean, reasons:string[]}}
 */
export function readGroupPrs({ repo, headSha, baseSha, headRef, cwd, base = 'main', exec = execFileSync }) {
  let entries = [];
  let commits = [];
  let commitsRead = true;
  try {
    const [o, n] = repo.split('/');
    entries = ghJson(['api', 'graphql', '-f', `query=${QUEUE_QUERY}`, '-f', `o=${o}`, '-f', `n=${n}`, '-f', `b=${base}`], exec)?.data?.repository?.mergeQueue?.entries?.nodes || [];
  } catch { /* supplemental: it can only add PRs; the history cross-check below is what proves completeness */ }
  try {
    // --first-parent: only the queue's own per-PR commits, never a PR's internal commits (whose "(#NNN)" subjects
    // name backlog items, not PRs).
    commits = String(exec('git', ['log', '--first-parent', '--format=%H%x09%s', `${baseSha}..${headSha}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
      .split('\n').filter(Boolean).map((line) => { const i = line.indexOf('\t'); return { sha: line.slice(0, i), subject: line.slice(i + 1) }; });
  } catch { commitsRead = false; }
  // A commit whose subject names no PR (squash/rebase merge, a hand-made commit) is resolved through the
  // commit→PR API; anything still unmapped makes the group incomplete.
  const resolved = {};
  for (const c of commits) {
    if (prNumberOfSubject(c.subject)) continue;
    try { resolved[c.sha] = (ghJson(['api', `repos/${repo}/commits/${c.sha}/pulls`], exec) || []).map((p) => Number(p?.number)).filter((x) => Number.isInteger(x) && x > 0); }
    catch { resolved[c.sha] = []; }
  }
  return groupMembership({ headRef, headSha, entries, commits, commitsRead, resolved });
}

/**
 * The shared red-main freeze for this run (xyd06qo): read ONCE, from the run's checkout, off the branch the policy
 * cascade names — the same knob the writer (`red-main-remediation.mjs`) publishes to. Never throws (unreadable is
 * `{source, error}`, which the evaluator fails closed on).
 */
export function readRedMainFact({ cwd, policy, read = readSharedFreeze }) {
  return read({ board: cwd, branch: policy.redMainFreezeBranch });
}

/**
 * The event the verdict is for, read off the invocation and the runner's own event (never off the configured
 * strategy): `--merge-group`, or Actions' `GITHUB_EVENT_NAME=merge_group` even when the flags say `--pr`, is a
 * queue merge. `'pull_request'` needs POSITIVE proof — the runner reporting exactly `pull_request` — because it is
 * the only event where `evaluatePrGates` may hand a gate to the drain. An absent or unrecognised runner event (a
 * local run, workflow_dispatch, odd casing, a future event name) is `null`: every gate is evaluated, none skipped.
 */
export function mergeEventOfFlags(f, env = process.env) {
  if (f?.['merge-group'] || env?.GITHUB_EVENT_NAME === 'merge_group') return 'merge_group';
  return env?.GITHUB_EVENT_NAME === 'pull_request' ? 'pull_request' : null;
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
  let membership = null;
  if (f['merge-group']) {
    membership = readGroupPrs({ repo, headSha: f['head-sha'], baseSha: f['base-sha'], headRef: f['head-ref'] || '', cwd, base: defaultBranch || 'main' });
    nums = membership.nums;
    if (f['list-group']) {
      // An incomplete list is refused outright (no numbers printed): a caller must never act on part of a group.
      if (!membership.complete) { process.stderr.write(`merge-gate-check: merge group membership incomplete — ${membership.reasons.join('; ')}\n`); process.exit(1); }
      writeAllSync(1, nums.map((x) => `${x}\n`).join('')); process.exit(nums.length ? 0 : 1);
    }
    if (typeof f['group-tree'] === 'string') {
      const d = join(resolve(f['group-tree']), 'backlog');
      groupDup = existsSync(d) ? findDuplicateIds(d) : [{ id: `group tree has no backlog dir (${d})` }];
    }
    // Without --group-tree, evaluatePrGates fails duplicate-id-on-main closed for every PR on this merge_group run.
  } else {
    nums = String(f.pr || '').split(',').map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x > 0);
    if (!nums.length) { process.stderr.write('merge-gate-check: --pr=<n>[,<n>…] or --merge-group required\n'); process.exit(3); }
  }

  const blockOnCodeQL = loadDrainGateSettings().drainBlocksOnCodeQL;
  // One read of the shared red-main freeze for the whole run (xyd06qo); branch name from the same policy cascade.
  const redMain = readRedMainFact({ cwd, policy });
  process.stderr.write(`red-main freeze (${redMain.source}): ${redMain.error ? `UNREADABLE — ${redMain.error}` : redMain.frozen ? `FROZEN — ${redMain.reason}` : 'clear'}\n`);
  const ledgerConfig = readLedgerConfig();
  const prs = nums.map((num) => evaluatePrGates(gatherPrFacts({ repo, num, cwd, defaultBranch, groupDuplicateIds: groupDup, ledgerConfig, redMain }), { policy, blockOnCodeQL, mergeEvent: mergeEventOfFlags(f) }));
  const verdict = f['merge-group'] ? evaluateGroup(prs, membership) : { ok: prs.every((p) => p.ok), reason: prs.every((p) => p.ok) ? 'all pass' : 'held', prs };
  if (f.json) writeAllSync(1, `${JSON.stringify({ ok: verdict.ok, reason: verdict.reason, policy, prs }, null, 2)}\n`);
  else {
    for (const p of prs) writeAllSync(1, `${formatPrResult(p)}\n`);
    writeAllSync(1, `merge-gate: ${verdict.ok ? 'PASS' : 'HOLD'} — ${verdict.reason}\n`);
  }
  process.exit(verdict.ok ? 0 : 1);
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) main().catch((e) => { process.stderr.write(`merge-gate-check ✗ ${e?.stack || e}\n`); process.exit(1); });
