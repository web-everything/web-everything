/** Fresh, daemon-owned evidence for the repair push fence; never reads scope from the fixer's working tree. */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { laneRefItemNum } from './lease-reaper.mjs';
import { repoKeyForSlug } from '../lib/constellation-repos.mjs';
import { defaultLoadItems, findItem } from '../operations/dispatch-lane-io.mjs';
import { planFixesFromReconcile, fetchPrDiffScope, fetchPrDiffPaths, fetchCardScopeAtRef } from './reconcile-fix-dispatch.mjs';
import { readCompletePrComments } from './pr-comments-complete.mjs';
import { unescapeTsvField } from './pr-comments-list.mjs';
import { buildStandDownComment, STAND_DOWN_LABEL } from './stand-down.mjs';
import { isSubtreeEntry } from '../readiness/scope-lease.mjs';
import { addedLines, declaredScopePaths, fencedPush, inertText, operatorScope, removalMarkers, resolveScopeFence, ScopeFenceEvidenceError, ScopeFenceHeadMovedError } from './fix-scope-fence.mjs';

/**
 * Pins the diff output the fence parses against lane config and attributes: no colour, every file as text (a binary
 * attribute or driver, `core.bigFileThreshold` or NUL sniffing would otherwise print only "Binary files differ"),
 * whole-tree paths, and submodule changes always listed.
 */
const FENCE_DIFF = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--text', '--no-relative', '--ignore-submodules=none', '--submodule=short'];
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MAX_MERGED = 20;
const FENCE_MAX_BUFFER = 64 * 1024 * 1024;
const FENCE_MAX_GIT_READS = 2000;
const FENCE_READ_TIMEOUT = 120_000;

function isAncestor(git, a, b) {
  try { git(['merge-base', '--is-ancestor', a, b]); return true; } catch (e) {
    if (e.status === 1) return false;
    throw e;
  }
}

/**
 * The newest commit a catch-up merge (`git merge <base sha>`) brought into `sha`, when GitHub confirms it is part of the
 * PR's base; null otherwise. Only GitHub's answer counts: a merge parent is fixer-chosen, so an unverified one is
 * treated as the fixer's own change.
 */
export function mergedBase({ git, gh, repo, head, sha, base }) {
  const parents = git(['rev-list', '--first-parent', '--merges', '--parents', `${head}..${sha}`])
    .split('\n').flatMap(line => line.trim().split(' ').slice(2)).filter(p => OID.test(p));
  const merged = [...new Set(parents)].filter(p => !isAncestor(git, p, head));
  if (!merged.length || merged.length > MAX_MERGED || !OID.test(String(base ?? ''))) return null;
  const newest = merged.find(c => merged.every(o => o === c || isAncestor(git, o, c)));
  const verified = [];
  for (const candidate of newest ? [newest, ...merged.filter(c => c !== newest)] : merged) {
    let status;
    try { status = gh(['api', `repos/${repo}/compare/${candidate}...${base}`, '--jq', '.status']).trim(); } catch (e) {
      if (/HTTP (?:404|422)/.test(String(e?.stderr ?? e?.message ?? e))) continue;
      throw e;
    }
    if (status === 'ahead' || status === 'identical') {
      if (candidate === newest) return candidate;
      verified.push(candidate);
    }
  }
  return verified.find(c => verified.every(o => o === c || isAncestor(git, o, c))) ?? null;
}

/** Credit only verified upstream trees and unchanged PR patches; never replay lane merge drivers or attributes. */
function mergeScopePaths({ git, names, head, sha, merged }) {
  const range = [`${head}..${sha}`, ...(merged ? [`^${merged}`] : [])];
  // Include side-branch repairs, and retain evidence even when a later commit reverts them.
  const commits = git(['rev-list', '--no-merges', ...range]).split('\n').filter(Boolean);
  const paths = new Set(merged ? [] : names(head, sha));
  for (const c of commits) {
    const changed = git(['diff-tree', '--root', '--no-commit-id', '-r', ...FENCE_DIFF.slice(1), '--name-only', '-z', c, '--']);
    for (const p of changed.split('\0').filter(Boolean)) paths.add(p);
  }
  // Retain coordinates, whitespace, modes and edit text; blob IDs and hunk section headings are context only.
  // A shifted or rewritten conflict resolution that cannot be proved unchanged requires declared scope.
  const patch = (from, to, p) => git([...FENCE_DIFF, '-U0', from, to, '--', `:(top,literal)${p}`])
    .split('\n').filter(line => !line.startsWith('index '))
    .map(line => line.replace(/^(@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@).*$/, '$1')).join('\n');
  const merges = git(['rev-list', '--merges', '--parents', ...range]).split('\n').filter(Boolean);
  for (const line of merges) {
    const [c, first, ...side] = line.split(' ');
    const upstream = merged && side.filter(p => isAncestor(git, p, merged));
    const parent = upstream && upstream.find(p => upstream.every(o => o === p || isAncestor(git, o, p)));
    const bases = parent ? git(['merge-base', '--all', first, parent]).trim().split('\n').filter(Boolean) : [];
    const differsFromUpstream = new Set(parent ? names(parent, c) : []);
    for (const p of names(first, c)) {
      if (parent && !differsFromUpstream.has(p)) continue;
      if (bases.length === 1 && patch(bases[0], first, p) === patch(parent, c, p)) continue;
      paths.add(p);
    }
  }
  return [...paths];
}

const COMMITS_QUERY = 'query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){commits(first:100,after:$endCursor){totalCount pageInfo{hasNextPage endCursor} nodes{commit{oid message}}}}}}';

/** Every commit message on the PR, paginated past the first 100. Throws unless the list is provably complete and ends at `head`. */
export function readPrCommitMessages({ gh, repo, pr, head }) {
  const [owner, name] = repo.split('/');
  const out = gh(['api', 'graphql', '--paginate', '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${Number(pr)}`, '-f', `query=${COMMITS_QUERY}`,
    '--jq', '.data.repository.pullRequest.commits | (.totalCount | tostring), (.nodes[] | [.commit.oid, .commit.message] | @tsv)']);
  const totals = new Set(), commits = [];
  for (const line of out.split('\n').filter(Boolean)) {
    if (/^\d+$/.test(line)) { totals.add(Number(line)); continue; }
    const tab = line.indexOf('\t');
    commits.push({ oid: line.slice(0, tab), message: unescapeTsvField(line.slice(tab + 1)) });
  }
  const detail = `PR commit list incomplete (read ${commits.length} of ${[...totals].join('/') || '?'}, ending at ${String(commits.at(-1)?.oid ?? 'none').slice(0, 8)})`;
  // A push during the read changes the count or the last commit, so a retry can succeed; a stable short count cannot.
  if (totals.size !== 1 || commits.at(-1)?.oid !== head) throw new Error(detail);
  if (commits.length !== [...totals][0]) throw Object.assign(new Error(detail), { permanent: true });
  return commits;
}

export function createScopeFencedPush({ root, exec = execFileSync, env = process.env, log = console.error, loadItems = () => defaultLoadItems(root), readComments = readCompletePrComments }) {
  const gh = (args, timeout = 60_000) => String(exec('gh', args, { encoding: 'utf8', env, timeout, maxBuffer: 32 * 1024 * 1024 }));
  return ({ repo, pr, sha, git: port, push }) => {
    // Commit-to-commit reads only; the port supplies the lane hardening. Replace refs, grafts and a commit-graph are lane
    // state that would show the fence a history the push never sends, and the buffer is sized for `--text` patches.
    // The port merges `opts.env` over its own environment; the pathspec switches are pinned off so `:(literal)` magic holds.
    const readDiff = context => {
      const { head, base, removed = [] } = context;
      const deadline = Date.now() + FENCE_READ_TIMEOUT;
      let reads = 0;
      const exhausted = () => new ScopeFenceEvidenceError(`repair history exceeds ${FENCE_MAX_GIT_READS} Git reads or ${FENCE_READ_TIMEOUT / 1000} seconds`, context);
      const git = args => {
        const remaining = deadline - Date.now();
        if (++reads > FENCE_MAX_GIT_READS || remaining <= 0) throw exhausted();
        try {
          return port(['--no-replace-objects', '-c', 'core.commitGraph=false', ...args],
            { maxBuffer: FENCE_MAX_BUFFER, timeout: remaining, env: { GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null',
              GIT_LITERAL_PATHSPECS: '0', GIT_GLOB_PATHSPECS: '0', GIT_NOGLOB_PATHSPECS: '0', GIT_ICASE_PATHSPECS: '0' } });
        } catch (e) {
          if (Date.now() >= deadline) throw exhausted();
          throw e;
        }
      };
      const budgetGh = args => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw exhausted();
        try { return gh(args, Math.min(60_000, remaining)); } catch (e) {
          if (Date.now() >= deadline) throw exhausted();
          throw e;
        }
      };
      // Prove our saved commit exists before attributing a missing remote head to branch movement.
      git(['cat-file', '-e', `${sha}^{commit}`]);
      try { git(['cat-file', '-e', `${head}^{commit}`]); } catch (e) {
        if (e.status === 1 || e.status === 128) throw new ScopeFenceHeadMovedError(head, sha);
        throw e;
      }
      try { git(['merge-base', '--is-ancestor', head, sha]); } catch (e) {
        if (e.status === 1) throw new ScopeFenceHeadMovedError(head, sha);
        throw e;
      }
      const names = (from, to) => git([...FENCE_DIFF, '--name-only', '-z', from, to, '--']).split('\0').filter(Boolean);
      // Identifier patches are read only when there is a removed identifier to look for.
      const added = (from, to, pathspec = []) => removed.length ? addedLines(git([...FENCE_DIFF, '-U0', from, to, '--', ...pathspec])) : [];
      const merged = mergedBase({ git, gh: budgetGh, repo, head, sha, base });
      const paths = mergeScopePaths({ git, names, head, sha, merged });
      // An extensionless scope entry covers a subtree only where it was a directory at the commit GitHub reports the PR
      // forked from (an ancestor of the head, so local). Agents wrote the head: a file the PR replaced, or a path it
      // created, stays one exact file. No fork point → exact.
      const bare = declaredScopePaths(context.scope, context.repo).filter(s => isSubtreeEntry(s) && !/\/$|[*?]/.test(s));
      let fork = '';
      if (bare.length && OID.test(String(base ?? ''))) {
        try { fork = budgetGh(['api', `repos/${repo}/compare/${base}...${head}`, '--jq', '.merge_base_commit.sha']).trim(); } catch (e) {
          if (!/HTTP (?:404|422)/.test(String(e?.stderr ?? e?.message ?? e))) throw e;
        }
      }
      const directories = !OID.test(fork) ? [] : bare.filter(s => git(['ls-tree', '--full-name', '-z', fork, '--', `:(top,literal)${s}`])
        .split('\0').some(r => r.slice(r.indexOf('\t') + 1) === s && r.split(' ')[1] === 'tree'));
      if (!merged) return { paths, additions: added(head, sha), directories };
      // Identifier exclusions also guard conflict resolutions that restore an operator removal. This is separate from
      // file scope. Never replay a merge using the lane's fixer-writable config and attributes.
      // Judge PR paths (and upstream renames of them) against the PR head; judge other additions against the merged base.
      const bases = git(['merge-base', '--all', head, merged]).split('\n').filter(Boolean);
      const pr = new Set(bases.flatMap(b => names(b, head)));
      for (const b of bases) {
        const f = git([...FENCE_DIFF.filter(a => a !== '--no-renames'), '-M', '-l0', '--diff-filter=R', '--name-status', '-z', b, merged, '--']).split('\0');
        for (let i = 0; i + 2 < f.length; i += 3) {
          if (!/^R\d*$/.test(f[i])) throw new Error('upstream rename list unreadable');
          if (pr.has(f[i + 1])) pr.add(f[i + 2]);
        }
      }
      const literal = magic => p => `:(top,literal${magic})${p}`;
      const prPaths = names(head, sha).filter(p => pr.has(p));
      return { paths, directories,
        additions: [...(prPaths.length ? added(head, sha, prPaths.map(literal(''))) : []), ...added(merged, sha, [...pr].map(literal(',exclude')))] };
    };
    const resolved = resolveScopeFence({ env });
    const policy = resolved.value.scopeFence;
    try {
      log(`fix.scopeFence.enabled=${policy.enabled} (${resolved.sources['scopeFence.enabled']}); fix.scopeFence.mode=${policy.mode} (${resolved.sources['scopeFence.mode']})`);
    } catch (e) { if (policy.mode !== 'warn') throw e; }
    return fencedPush({ policy, push,
      readContext: () => {
        const key = repoKeyForSlug(repo);
        if (!key) throw new Error('unknown repo');
        const { baseRefOid: base = null, ...view } = JSON.parse(gh(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefName,headRefOid,baseRefOid']));
        if (!/^[0-9a-f]{40}$/.test(view.headRefOid)) throw new Error('missing PR head');
        const comments = readComments(pr, { repo, exec });
        const operator = operatorScope(comments);
        const evidence = { head: view.headRefOid, comments };
        if (operator.incomplete) throw new ScopeFenceEvidenceError(`operator scope evidence incomplete: ${operator.incomplete.join('; ')}`, evidence);
        let commitMarkers;
        try {
          commitMarkers = readPrCommitMessages({ gh, repo, pr, head: view.headRefOid }).flatMap(c => removalMarkers(c.message));
        } catch (e) {
          if (e.permanent || e instanceof RangeError) throw new ScopeFenceEvidenceError(e.message, evidence);
          throw e;
        }
        // An unreadable backlog must withhold the push: `findItem` reads a loader failure as "no card", and the planner
        // would then fence with the PR's own, wider diff scope.
        let items;
        try { items = loadItems(); } catch (e) { throw new Error(`backlog unreadable: ${inertText(e?.message)}`); }
        if (!Array.isArray(items)) throw new Error('backlog unreadable: the loader returned no item list');
        // The loader skips a card whose frontmatter does not parse; that card is unreadable, not absent.
        const itemNum = laneRefItemNum(view.headRefName);
        if (itemNum && !findItem(itemNum, () => items)) {
          let cards;
          try { cards = readdirSync(env.WE_BACKLOG_DIR || join(root, 'backlog')); } catch (e) { if (e?.code !== 'ENOENT') throw new Error(`backlog unreadable: ${inertText(e?.message)}`); }
          if (cards?.some(f => f.startsWith(`${itemNum}-`) && f.endsWith('.md'))) throw new Error(`backlog unreadable: card ${inertText(itemNum)} exists but the loader skipped it`);
        }
        const options = { root, repo, exec };
        const result = planFixesFromReconcile([{ kind: 'fix', prNumber: pr, ...view }], findItem,
          () => items, n => fetchPrDiffScope(n, options), key,
          n => fetchPrDiffPaths(n, options), (path, ref) => fetchCardScopeAtRef(path, ref, options));
        const scope = result.planned[0]?.scope;
        if (!scope?.length) throw new Error('declared scope could not be resolved');
        const removed = [...operator.removed, ...commitMarkers];
        return { scope, repo: key, removed, head: view.headRefOid, base, comments };
      },
      readDiff: context => {
        try { return readDiff(context); } catch (e) {
          // Output too large to read in full, or a path list too long to pass, will not shrink on retry: a person decides.
          if (e?.code === 'ENOBUFS') throw new ScopeFenceEvidenceError(`git output exceeds ${FENCE_MAX_BUFFER / 1024 / 1024} MiB`, context);
          if (e?.code === 'E2BIG') throw new ScopeFenceEvidenceError('PR path list exceeds the argument limit', context);
          throw e;
        }
      },
      standDown: (reason, { head, comments }) => {
        const body = buildStandDownComment({ reason: 'scope-increase', detail: reason, head });
        if (!comments.some(c => c.body === body)) gh(['pr', 'comment', String(pr), '--repo', repo, '--body', body]);
        gh(['label', 'create', STAND_DOWN_LABEL, '--repo', repo, '--color', 'b60205', '--description', 'fixer stood down; needs-you', '--force']);
        gh(['pr', 'edit', String(pr), '--repo', repo, '--add-label', STAND_DOWN_LABEL]);
      },
      note: event => log(JSON.stringify({ ...event, repo, pr, sha })),
    });
  };
}
