/** PUSH-GATE-S1: the claim-bound push gate must refuse a PR carrying review:human and push nothing. */
import { readGit } from '../../../lib/proc-read.mjs';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const GATE_COMMIT = '7665f83b75e2249edf92739e070280b0755d6d6d';
export default {
  id: 'push-gate-hold-refusal',
  title: 'Claim-bound push gate refuses a review:human PR with no push',
  card: 'PUSH-GATE-S1C',
  fixedBy: { sha: GATE_COMMIT, where: 'lane/push-gate-s1', paths: ['scripts/lib/authorized-push.mjs'] },
  // Decided by git ancestry of the gate commit, never by the behaviour under test.
  fixPresent(root) {
    try { readGit(['-C', root, 'merge-base', '--is-ancestor', GATE_COMMIT, 'HEAD']); return true; } catch { return false; }
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const violations = [];
    const scratch = mkdtempSync(join(tmpdir(), 'push-gate-soak-'));
    try {
      const { createAuthorizedPushForTesting } = await import(pathToFileURL(join(sourceRoot, 'scripts/lib/__tests__/helpers/authorized-push-factory.mjs')).href);
      const head = 'a'.repeat(40), sha = 'b'.repeat(40);
      let pushes = 0;
      const entry = { meta: { repo: 'we', pr: 42, kind: 'fixing', ttlMinutes: 20, branch: 'lane/fix', sessionId: 'mine' } };
      const io = {
        gh: 'fixture-gh', isAncestor: () => true,
        readClaim: () => entry, branchClaimRefusal: () => null,
        ghPrView: () => ({ headRefName: 'lane/fix', headRefOid: head, labels: [{ name: 'review:human' }],
          state: 'OPEN', isDraft: false, isCrossRepository: false }),
        spawn: (_bin, args) => {
          if (args.includes('push')) pushes++;
          if (args.includes('init')) mkdirSync(join(args.at(-1), 'objects/info'), { recursive: true });
          return { status: 0, stdout: args.includes('--git-common-dir') ? `${scratch}\n` : `${join(scratch, 'missing-lease')}\n` };
        },
        gitPush: () => { pushes++; return { status: 0, stdout: `\t${sha}:refs/heads/lane/fix\naaaa..bbbb\nDone\n` }; },
      };
      const result = createAuthorizedPushForTesting(io).authorizedPush({ repo: 'we', pr: 42, branch: 'lane/fix',
        expectedHead: head, sha, gitDir: scratch, purpose: 'repair', holder: { sessionId: 'mine' } });
      log?.(`review:human PR: ${JSON.stringify(result)} pushes=${pushes}`);
      if (result?.ok !== false) violations.push(`gate did not refuse a review:human PR: ${JSON.stringify(result)}`);
      else if (result.code !== 'hold-label') violations.push(`refused for the wrong reason: ${result.code}`);
      if (pushes) violations.push(`pushed ${pushes} time(s) under a review:human hold`);
    } catch (error) {
      violations.push(`gate call failed: ${error?.message || error}`);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
    return { violations };
  },
  judge: report => report.violations,
};
