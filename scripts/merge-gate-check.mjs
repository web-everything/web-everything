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
 *   --expect-head=<sha> (pull_request: the event's head sha — every git read is pinned to it) ·
 *   --print-ruleset (print the ruleset the operator must apply, from rulesetSuggestion, and exit)
 *
 * SECURITY: the workflow runs THIS script from `main` (never the PR's ref), so a PR cannot neuter the gate's
 * SCRIPTS. The PR's body/labels/diff are read as DATA only, and every git read is pinned to the PR's exact head
 * SHA (`headRefOid`, the event's sha, or for a merge group each PR's sha inside the group) — never to the branch
 * NAME, which can move after the event or name a different ref (`pinnedHeadOf` / `gatherPrFacts`).
 * The workflow YAML is read by GitHub from the PR merge ref / group commit, so (1) the evaluation refuses to pass
 * unless the RUNNING workflow file is byte-identical to main's (`verifyRunningWorkflow`; fail closed) and (2) the
 * only defence against a YAML edit that never reaches this script (`exit 0`) is the ruleset's `workflows` pin to
 * refs/heads/main plus the GitHub Actions integration-id restriction (`--print-ruleset`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluatePrGates, evaluateGroup, groupMembership, prNumberOfSubject, formatPrResult } from './lib/merge-gate-ci.mjs';
import { readDrainAcceptance, computeNetDiffSignals, computeNetDiffText } from './merge-ai-prs.mjs';
import { extractManifestFromBody } from './readiness/lane-manifest.mjs';
import { remoteManifestApiArgs } from './lib/remote-manifest.mjs';
import { findDuplicateIds } from './lib/duplicate-id-tripwire.mjs';
import { loadDrainGateSettings } from './lib/codeql-gate.mjs';
import { loadMergeDeliveryPolicy, formatMergeDeliverySourcesLine } from './lib/merge-delivery-policy.mjs';
import { readSettings, readDeclaredSettings } from './lib/settings-files.mjs';
import { GATE_IDS } from './lib/merge-gate-inventory.mjs';
import { REVIEW_AUTHORITIES } from './lib/pr-merge-gate.mjs';
import { rulesetSuggestion } from './lib/merge-queue-enqueue.mjs';
import { writeAllSync } from './lib/write-all-sync.mjs';

const firstLine = (e) => String(e?.stderr || e?.message || e).trim().split('\n').pop().slice(0, 300);
const ghJson = (args, exec) => JSON.parse(exec('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }) || 'null');

const PR_FIELDS = 'number,title,body,labels,commits,headRefName,headRefOid,baseRefName,statusCheckRollup,isCrossRepository';
const BODY_HISTORY_QUERY = 'query($o:String!,$n:String!,$pr:Int!){repository(owner:$o,name:$n){pullRequest(number:$pr){userContentEdits(first:100){totalCount nodes{editedAt diff}}}}}';
const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * The exact commit this run judges for one PR. `expected` is the event's head sha (pull_request) or the PR's sha
 * inside the merge group; without one, the `headRefOid` read with the PR facts. Never the branch name. Returns
 * `{sha}` or `{error}` (fail closed): a malformed sha, a merge group with no per-PR sha, a head that moved since
 * the event (the PR facts no longer describe the judged commit; the new head's own run decides), or a fork head.
 * Pure.
 */
export function pinnedHeadOf(pr, { expected = null, requireExpected = false } = {}) {
  if (pr?.isCrossRepository !== false) return { error: `cross-repository (fork) head${pr?.isCrossRepository === true ? '' : ' — isCrossRepository unread'}: not evaluated` };
  if (requireExpected && !expected) return { error: 'no pinned head sha for this PR in the merge group' };
  const live = String(pr?.headRefOid || '');
  if (!SHA_RE.test(live)) return { error: `PR headRefOid is not a 40-hex sha (${JSON.stringify(live).slice(0, 60)})` };
  if (expected == null) return { sha: live };
  if (!SHA_RE.test(String(expected))) return { error: `pinned head is not a 40-hex sha (${JSON.stringify(String(expected)).slice(0, 60)})` };
  if (expected !== live) return { error: `head moved since the event: judged ${expected.slice(0, 9)}, PR now at ${live.slice(0, 9)}` };
  return { sha: expected };
}

/**
 * Every historical body version, PROVEN to be full bodies. `UserContentEdit.diff` carries the whole body text of
 * that version (verified on live PRs: the newest edit equals the live body byte for byte). That is checked per
 * PR, not assumed: when edits exist, the newest one (by editedAt) must equal the live body, else the history is
 * not provably full bodies and is reported incomplete (fail closed) — a real diff/fragment can never be read as a
 * body that merely lacks the manifest. Pure.
 */
export function bodyHistoryOf(liveBody, edits) {
  if (!edits) return { error: 'no userContentEdits in response' };
  const nodes = Array.isArray(edits.nodes) ? edits.nodes : [];
  const live = String(liveBody ?? '');
  // `diff` is nullable (a deleted/redacted edit): a node we could not read is a version we never saw, so the
  // history is complete only when every counted edit was returned AND carried a readable body.
  const readable = Array.isArray(edits.nodes) && edits.totalCount <= nodes.length && nodes.every((x) => typeof x?.diff === 'string');
  const bodies = [live, ...nodes.map((x) => x?.diff).filter((x) => typeof x === 'string')];
  if (!readable) return { bodies, complete: false, reason: 'edit history truncated or has an unreadable version' };
  if (!nodes.length) return { bodies, complete: true };
  const newest = [...nodes].sort((a, b) => String(b?.editedAt || '').localeCompare(String(a?.editedAt || '')))[0];
  const norm = (t) => String(t).replace(/\r\n/g, '\n');
  if (!newest?.editedAt || norm(newest.diff) !== norm(live)) {
    return { bodies, complete: false, reason: 'newest edit is not the live body — edit entries are not provably full bodies' };
  }
  return { bodies, complete: true };
}

/**
 * The running workflow's definition must be main's, byte for byte (GitHub reads the YAML from the PR merge ref or
 * the group commit, so a PR can change what the required check does). Reads `GITHUB_WORKFLOW_REF`
 * (`owner/repo/<path>@<ref>`) and `GITHUB_WORKFLOW_SHA` (the commit the YAML came from) and compares
 * `git show <sha>:<path>` with `git show origin/<main>:<path>`. Outside Actions there is no running workflow:
 * `{ok:true, local:true}`. Any unreadable piece fails closed. Never throws.
 * HONEST LIMIT: this runs only when the YAML still reaches this script; a YAML edited to `exit 0` never does —
 * that case is closed only by the ruleset `workflows` pin (refs/heads/main) and the Actions integration id.
 */
export function verifyRunningWorkflow({ env = process.env, cwd, defaultBranch = 'main', exec = execFileSync } = {}) {
  if (env.GITHUB_ACTIONS !== 'true') return { ok: true, local: true, reason: 'not running in GitHub Actions' };
  const m = String(env.GITHUB_WORKFLOW_REF || '').match(/^[^/]+\/[^/]+\/(\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml)@(.+)$/);
  const sha = String(env.GITHUB_WORKFLOW_SHA || '');
  if (!m) return { ok: false, reason: `GITHUB_WORKFLOW_REF unreadable (${JSON.stringify(env.GITHUB_WORKFLOW_REF || '').slice(0, 120)})` };
  if (!SHA_RE.test(sha)) return { ok: false, reason: 'GITHUB_WORKFLOW_SHA is not a 40-hex sha' };
  if (!/^[A-Za-z0-9._/-]+$/.test(String(defaultBranch)) || String(defaultBranch).startsWith('-')) return { ok: false, reason: 'default branch name unusable' };
  const path = m[1];
  const git = (args) => String(exec('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }));
  try {
    try { git(['cat-file', '-e', `${sha}^{commit}`]); } catch { git(['fetch', '--quiet', '--end-of-options', 'origin', sha]); }
    git(['fetch', '--quiet', '--end-of-options', 'origin', `+${defaultBranch}:refs/remotes/origin/${defaultBranch}`]);
    const running = git(['show', `${sha}:${path}`]);
    const onMain = git(['show', `refs/remotes/origin/${defaultBranch}:${path}`]);
    if (running !== onMain) return { ok: false, path, reason: `running workflow ${path} at ${sha.slice(0, 9)} differs from ${defaultBranch}'s — a PR may not change the gate that judges it` };
    return { ok: true, path, reason: `running workflow ${path} matches ${defaultBranch}` };
  } catch (e) { return { ok: false, path, reason: `running workflow could not be compared with ${defaultBranch}'s: ${firstLine(e)}` }; }
}

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
export function gatherPrFacts({ repo, num, cwd, defaultBranch, groupDuplicateIds = null, ledgerConfig = null, expectedHeadSha = null, requireExpectedHead = false, exec = execFileSync }) {
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

  // THE JUDGED COMMIT: every git read below is pinned to this exact sha, never to pr.headRefName.
  const pin = pinnedHeadOf(pr, { expected: expectedHeadSha, requireExpected: requireExpectedHead });
  facts.pinnedHead = pin;

  // Manifest: the PR body first, the legacy tree file (at the pinned sha) second (the drain's readPrManifest order).
  const fromBody = extractManifestFromBody(pr.body);
  if (fromBody) facts.manifest = { live: fromBody };
  else if (pin.error) facts.manifest = { live: null, error: `head not pinned: ${pin.error}` };
  else {
    try {
      const b64 = String(exec('gh', remoteManifestApiArgs(repo, pin.sha), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '').trim();
      const m = b64 ? JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) : null;
      facts.manifest = m && m.item != null ? { live: m, fromTree: true } : { live: null };
    } catch (e) {
      facts.manifest = /404|Not Found/i.test(String(e?.stderr || e?.message)) ? { live: null } : { live: null, error: firstLine(e) };
    }
  }

  // Net diff signals off the checkout (the drain's computeNetDiffSignals) at the pinned sha. The sha must be
  // fetchable and resolve to a commit, and the diff must be OF that sha; anything else fails closed. No `gh pr
  // view --json files` fallback: that list describes whatever the branch points at now, not the judged commit.
  if (pin.error) facts.netSignals = { scored: false, error: `head not pinned: ${pin.error}` };
  else {
    try {
      try { gitExec('git', ['fetch', '--quiet', '--end-of-options', 'origin', pin.sha], { stdio: ['ignore', 'ignore', 'pipe'] }); }
      catch { /* may already be present (merge group history); the cat-file probe below decides */ }
      try { gitExec('git', ['cat-file', '-e', `${pin.sha}^{commit}`], { stdio: ['ignore', 'ignore', 'pipe'] }); }
      catch (e) { throw new Error(`pinned head ${pin.sha.slice(0, 9)} is not fetchable: ${firstLine(e)}`); }
      const sig = computeNetDiffSignals({ exec: gitExec, rev: pin.sha, baseRev: facts.manifest?.live?.base ?? null, fetchExtraRefs: [] });
      if (!sig.scored || sig.netDiffText?.rev !== pin.sha) {
        facts.netSignals = { scored: false, error: `net diff not computed at the pinned head ${pin.sha.slice(0, 9)} (${sig.netDiffText?.rev ? `resolved ${sig.netDiffText.rev}` : sig.netDiffText?.reason || 'unscored'})` };
      } else facts.netSignals = sig;
    } catch (e) { facts.netSignals = { scored: false, error: firstLine(e) }; }
  }

  // Review acceptance evidence (comments + markers), read exactly as the drain reads it, but its live-diff read
  // is pinned to the judged sha and its own head read must agree with the pin (else it describes another commit).
  if ((pr.labels || []).some((l) => (l?.name ?? l) === 'review:accepted')) {
    if (pin.error) facts.acceptance = { error: `head not pinned: ${pin.error}` };
    else {
      try {
        const acc = readDrainAcceptance({ pr: num, repo, cwd, local: true, exec: (c, a, o) => exec(c, a, { cwd, ...o }),
          netDiff: (o) => { const t = computeNetDiffText({ ...o, rev: pin.sha, fetchExtraRefs: [] }); return t?.rev === pin.sha ? t : { ...t, scored: false }; } });
        facts.acceptance = acc?.headSha === pin.sha ? acc : { error: `acceptance read saw head ${String(acc?.headSha).slice(0, 9)}, not the pinned ${pin.sha.slice(0, 9)}` };
      } catch (e) { facts.acceptance = { error: firstLine(e) }; }
    }
  }

  // Body history: every earlier body version (proven full bodies — bodyHistoryOf) is a candidate manifest baseline.
  try {
    const [o, n] = repo.split('/');
    const d = ghJson(['api', 'graphql', '-f', `query=${BODY_HISTORY_QUERY}`, '-f', `o=${o}`, '-f', `n=${n}`, '-F', `pr=${num}`], exec);
    facts.bodyHistory = bodyHistoryOf(pr.body || '', d?.data?.repository?.pullRequest?.userContentEdits);
  } catch (e) { facts.bodyHistory = { error: firstLine(e) }; }

  // Duplicate ids on main (the checkout this script runs from) and, for a merge group, the group's tree.
  const scan = (dir) => (existsSync(dir) ? findDuplicateIds(dir) : null);
  const mainDup = scan(join(cwd, 'backlog'));
  if (mainDup === null) facts.duplicateIds = { error: `no backlog dir at ${cwd}` };
  else if (groupDuplicateIds && !Array.isArray(groupDuplicateIds)) facts.duplicateIds = { error: `group tree scan: ${groupDuplicateIds.error || 'unreadable'}` };
  else facts.duplicateIds = { main: mainDup, ...(groupDuplicateIds ? { group: groupDuplicateIds } : {}) };

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

/**
 * The PR numbers in a merge group AND whether that list is provably complete (`groupMembership`). The queue API is
 * supplemental (it can only add PRs); the first-parent history is the cross-check — it must be readable and every
 * commit in it must map to a PR, else `complete` is false and BOTH callers (`--list-group`, the group verdict)
 * fail closed: a partial list would let the unlisted PRs merge unevaluated.
 * `heads` maps each PR to its exact sha inside the group: the second parent of its first-parent queue merge
 * commit. A PR with no such commit (a squash/rebase commit, two commits naming it) gets no entry, and the gatherer
 * then fails that PR closed rather than judging its branch name.
 * @returns {{nums:number[], complete:boolean, reasons:string[], heads:Record<number,string>}}
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
    commits = String(exec('git', ['log', '--first-parent', '--format=%H%x09%P%x09%s', `${baseSha}..${headSha}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
      .split('\n').filter(Boolean).map((line) => {
        const [sha, parents, ...rest] = line.split('\t');
        return { sha, parents: String(parents || '').split(' ').filter(Boolean), subject: rest.join('\t') };
      });
  } catch { commitsRead = false; }
  // A commit whose subject names no PR (squash/rebase merge, a hand-made commit) is resolved through the
  // commit→PR API; anything still unmapped makes the group incomplete.
  const resolved = {};
  for (const c of commits) {
    if (prNumberOfSubject(c.subject)) continue;
    try { resolved[c.sha] = (ghJson(['api', `repos/${repo}/commits/${c.sha}/pulls`], exec) || []).map((p) => Number(p?.number)).filter((x) => Number.isInteger(x) && x > 0); }
    catch { resolved[c.sha] = []; }
  }
  return { ...groupMembership({ headRef, headSha, entries, commits, commitsRead, resolved }), heads: groupHeadsOf(commits) };
}

/** PR number → its exact head sha in the group (second parent of its queue merge commit); ambiguous → omitted. Pure. */
export function groupHeadsOf(commits = []) {
  const heads = {};
  const seen = new Set();
  for (const c of commits || []) {
    const n = prNumberOfSubject(c?.subject);
    if (!n) continue;
    const second = Array.isArray(c?.parents) && c.parents.length === 2 ? c.parents[1] : null;
    if (seen.has(n) || !SHA_RE.test(String(second))) { delete heads[n]; seen.add(n); continue; }
    seen.add(n);
    heads[n] = second;
  }
  return heads;
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
  if (f['print-ruleset']) {
    const p = loadMergeDeliveryPolicy({ toolSettings: readSettings(), knownGates: GATE_IDS });
    writeAllSync(1, `${JSON.stringify(rulesetSuggestion(p), null, 2)}\n`); process.exit(0);
  }
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
      groupDup = existsSync(d) ? findDuplicateIds(d) : { error: `group tree has no backlog dir (${d})` };
    }
    // Without --group-tree, evaluatePrGates fails duplicate-id-on-main closed for every PR on this merge_group run.
  } else {
    nums = String(f.pr || '').split(',').map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x > 0);
    if (!nums.length) { process.stderr.write('merge-gate-check: --pr=<n>[,<n>…] or --merge-group required\n'); process.exit(3); }
  }

  const blockOnCodeQL = loadDrainGateSettings().drainBlocksOnCodeQL;
  const ledgerConfig = readLedgerConfig();
  const expectHead = typeof f['expect-head'] === 'string' && f['expect-head'] ? f['expect-head'] : null;
  if (expectHead && nums.length !== 1) { process.stderr.write('merge-gate-check: --expect-head pins exactly one --pr\n'); process.exit(3); }
  const pinOf = (num) => (f['merge-group'] ? { expectedHeadSha: membership?.heads?.[num] ?? null, requireExpectedHead: true } : { expectedHeadSha: expectHead });
  const prs = nums.map((num) => evaluatePrGates(gatherPrFacts({ repo, num, cwd, defaultBranch, groupDuplicateIds: groupDup, ledgerConfig, ...pinOf(num) }), { policy, blockOnCodeQL, mergeEvent: mergeEventOfFlags(f) }));
  const wfCheck = verifyRunningWorkflow({ cwd, defaultBranch: defaultBranch || 'main' });
  process.stderr.write(`merge-gate: workflow self-check — ${wfCheck.ok ? 'ok' : 'FAIL'}: ${wfCheck.reason}\n`);
  const base = f['merge-group'] ? evaluateGroup(prs, membership) : { ok: prs.every((p) => p.ok), reason: prs.every((p) => p.ok) ? 'all pass' : 'held', prs };
  const verdict = wfCheck.ok ? base : { ...base, ok: false, reason: `workflow self-check failed — fail closed: ${wfCheck.reason}; ${base.reason}` };
  if (f.json) writeAllSync(1, `${JSON.stringify({ ok: verdict.ok, reason: verdict.reason, workflowCheck: wfCheck, policy, prs }, null, 2)}\n`);
  else {
    for (const p of prs) writeAllSync(1, `${formatPrResult(p)}\n`);
    writeAllSync(1, `merge-gate: ${verdict.ok ? 'PASS' : 'HOLD'} — ${verdict.reason}\n`);
  }
  process.exit(verdict.ok ? 0 : 1);
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) main().catch((e) => { process.stderr.write(`merge-gate-check ✗ ${e?.stack || e}\n`); process.exit(1); });
