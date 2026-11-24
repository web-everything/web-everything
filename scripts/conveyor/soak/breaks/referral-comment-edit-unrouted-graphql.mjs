/**
 * @file breaks/referral-comment-edit-unrouted-graphql.mjs — live shape frontierui#55, 2026-11-23.
 *
 * BREAK: the review loop updates a referral's cumulative snapshot with a GraphQL `updateIssueComment` that names only
 * a comment node id. The gh app shim routes a graphql call by owner/name fields, else GH_REPO, else the daemon
 * checkout's origin, so for a frontier-ui PR it used the wrong owner's installation and the call failed. The referral
 * record then never persisted and the PR sat behind `referral-persistence-failed` after the retry budget was spent.
 * FIX: `review-comment-edit.mjs#editComment` takes the PR's repo and runs the call with GH_REPO set to it; with no
 * repo it refuses (fail closed) rather than send an unrouted call.
 *
 * SCENARIO: the real referral provider with a recording exec. No IO. Judged by behaviour, not by marker strings.
 * RED  = pre-fix: the call carries no GH_REPO, and a missing repo is sent anyway.
 * GREEN = the call carries GH_REPO=<pr repo>; a missing repo throws and sends nothing.
 */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const OK = JSON.stringify({ data: { updateIssueComment: { issueComment: { id: 'IC_x' } } } });

const module_default = {
  id: 'referral-comment-edit-unrouted-graphql',
  title: 'the referral snapshot edit is routed to the PR repo owner and refuses to run unrouted',
  card: 'frontierui#55 referral-persistence-failed (2026-11-23)',
  fixedBy: { sha: 'lane/referral-persist-recover', where: 'lane/referral-persist-recover', paths: ['scripts/lib/review-comment-edit.mjs'] },
  fixPresent(root) {
    const src = `import(${JSON.stringify(import.meta.url)}).then(m => m.probe(${JSON.stringify(root)})).then(ok => process.exit(ok ? 0 : 1), () => process.exit(1));`;
    return spawnSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8', timeout: 60_000 }).status === 0;
  },
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [];
    try {
      const { createReferralGhProvider } = await import(pathToFileURL(join(sourceRoot, 'scripts/lib/review-comment-edit.mjs')).href);
      const envs = [];
      const provider = createReferralGhProvider({ exec: (_argv, opts) => { envs.push(opts?.env); return OK; } });
      provider.editComment('IC_x', 'body', { repo: 'frontier-ui/frontierui' });
      if (envs[0]?.GH_REPO !== 'frontier-ui/frontierui') violations.push('the edit was sent without GH_REPO naming the PR repo');
      const before = envs.length;
      let threw = false;
      try { provider.editComment('IC_x', 'body'); } catch { threw = true; }
      if (!threw || envs.length !== before) violations.push('an edit with no repo was sent instead of refused');
    } catch (error) {
      violations.push(`scenario failed: ${error.stack ?? error}`);
    }
    return { violations };
  },
  judge: report => report.violations,
};

export default module_default;
export async function probe(root) {
  const { violations } = await module_default.run({ sourceRoot: root });
  return violations.length === 0;
}
