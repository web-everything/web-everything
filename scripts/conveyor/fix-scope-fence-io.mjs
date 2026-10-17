/** Fresh, daemon-owned evidence for the repair push fence; never reads scope from the fixer's working tree. */
import { execFileSync } from 'node:child_process';
import { repoKeyForSlug } from '../lib/constellation-repos.mjs';
import { defaultLoadItems, findItem } from '../operations/dispatch-lane-io.mjs';
import { planFixesFromReconcile, fetchPrDiffScope, fetchPrDiffPaths, fetchCardScopeAtRef } from './reconcile-fix-dispatch.mjs';
import { readCompletePrComments } from './pr-comments-complete.mjs';
import { buildStandDownComment, STAND_DOWN_LABEL } from './stand-down.mjs';
import { fencedPush, operatorScope, removalMarkers, resolveScopeFence, ScopeFenceHeadMovedError } from './fix-scope-fence.mjs';

export function createScopeFencedPush({ root, exec = execFileSync, env = process.env, log = console.error, loadItems = () => defaultLoadItems(root), readComments = readCompletePrComments }) {
  const gh = args => String(exec('gh', args, { encoding: 'utf8', env, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }));
  return ({ repo, pr, sha, git, push }) => {
    const resolved = resolveScopeFence({ env });
    const policy = resolved.value.scopeFence;
    log(`fix.scopeFence.enabled=${policy.enabled} (${resolved.sources['scopeFence.enabled']}); fix.scopeFence.mode=${policy.mode} (${resolved.sources['scopeFence.mode']})`);
    return fencedPush({ policy, push,
      readContext: () => {
        const key = repoKeyForSlug(repo);
        if (!key) throw new Error('unknown repo');
        const view = JSON.parse(gh(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefName,headRefOid,commits']));
        if (!/^[0-9a-f]{40}$/.test(view.headRefOid)) throw new Error('missing PR head');
        const comments = readComments(pr, { repo, exec });
        const operator = operatorScope(comments);
        const options = { root, repo, exec };
        const result = planFixesFromReconcile([{ kind: 'fix', prNumber: pr, ...view }], findItem,
          loadItems, n => fetchPrDiffScope(n, options), key,
          n => fetchPrDiffPaths(n, options), (path, ref) => fetchCardScopeAtRef(path, ref, options));
        const scope = result.planned[0]?.scope;
        if (!scope?.length) throw new Error('declared scope could not be resolved');
        const removed = [...operator.removed, ...view.commits.flatMap(c => removalMarkers(`${c.messageHeadline}\n${c.messageBody}`))];
        return { scope, repo: key, removed, head: view.headRefOid, comments };
      },
      readDiff: ({ head }) => {
        // Commit-to-commit reads only; hardening is supplied by the daemon's git port.
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
        const paths = git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', head, sha, '--']).split('\0').filter(Boolean);
        const patch = git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '-U0', head, sha, '--']);
        return { paths, patch };
      },
      standDown: (reason, { head, comments }) => {
        const body = buildStandDownComment({ reason: 'scope-increase', detail: reason, head });
        if (!comments.some(c => c.body === body)) gh(['pr', 'comment', String(pr), '--repo', repo, '--body', body]);
        gh(['label', 'create', STAND_DOWN_LABEL, '--repo', repo, '--color', 'b60205', '--description', 'fixer stood down; needs-you', '--force']);
        gh(['pr', 'edit', String(pr), '--repo', repo, '--add-label', STAND_DOWN_LABEL]);
      },
      note: (body, { comments }) => {
        log(body);
        if (!comments.some(c => c.body === body)) gh(['pr', 'comment', String(pr), '--repo', repo, '--body', body]);
      },
    });
  };
}
