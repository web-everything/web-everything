/** PR #7442 send-back x1b8hlo: a Git-valid neighboring claim must not poison push authority. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SOURCE = 'scripts/conveyor/fix-claim-store.mjs';
export default {
  id: 'push-gate-valid-neighbor',
  title: 'Git-valid live and expired neighboring claims preserve unrelated push authority',
  card: '5726',
  fixedBy: { sha: 'HEAD', where: 'lane/push-gate-s1', paths: [SOURCE] },
  fixPresent(root) {
    return readFileSync(join(root, SOURCE), 'utf8').includes('function isCanonicalClaimBranch(');
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const { fixBegin, pushRefusal, readLiveFixClaim } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/fix-procedure.mjs')).href);
    const { listFixDispatchClaimsStrict } = await import(pathToFileURL(join(sourceRoot, SOURCE)).href);
    const { lockDirFor } = await import(pathToFileURL(join(sourceRoot, 'scripts/readiness/file-locks.mjs')).href);
    const { createAuthorizedPushForTesting } = await import(pathToFileURL(join(sourceRoot, 'scripts/lib/__tests__/helpers/authorized-push-factory.mjs')).href);
    const violations = [];
    const head = 'a'.repeat(40), nowMs = Date.now();
    const labels = { ensureLabel() {}, setLabels() {}, postComment() {} };
    for (const branch of ['lane/repair+tests', 'feature/repair', 'lane/équipe']) {
      const lockRoot = mkdtempSync(join(tmpdir(), 'push-neighbor-soak-'));
      try {
        const own = { repo: 'we', pr: 42, who: 'mine', sessionId: 'mine', lockRoot, nowMs };
        const view = { headRefName: 'lane/fix', headRefOid: head, state: 'OPEN', isDraft: false,
          isCrossRepository: false, labels: [] };
        const begin = (options, headRefName) => fixBegin({ ...options, labels,
          gh: async args => {
            if (args[0] !== 'pr' || args[1] !== 'view') throw new Error('Unexpected GitHub effect');
            return JSON.stringify({ ...view, headRefName });
          } });
        const gate = createAuthorizedPushForTesting({ gh: 'fixture-gh', isAncestor: () => true,
          readClaim: () => readLiveFixClaim(own), ghPrView: () => view,
          branchClaimRefusal: () => pushRefusal({ ...own, branch: 'lane/fix', strict: true }),
          spawn: () => { throw new Error('Authority probe must not start a transport'); } });
        const authority = () => gate.readPushAuthority({ repo: 'we', pr: 42, branch: 'lane/fix',
          expectedHead: head, sha: head, gitDir: lockRoot, purpose: 'repair', holder: { sessionId: 'mine' } });
        if (!(await begin(own, 'lane/fix')).ok) throw new Error('Own fixBegin failed');
        if (!authority().ok) throw new Error('Authority failed before adding a neighbor');
        if (!(await begin({ ...own, pr: 99, who: 'other', sessionId: 'other' }, branch)).ok)
          throw new Error('Neighbor fixBegin failed');
        const file = join(lockDirFor(lockRoot, 'fix-dispatch:we:fixing:99'), 'lock.json');
        const neighbor = JSON.parse(readFileSync(file, 'utf8'));
        for (const [state, heartbeatAt] of [['live', neighbor.heartbeatAt], ['expired', '2020-01-01T00:00:00.000Z']]) {
          writeFileSync(file, JSON.stringify({ ...neighbor, heartbeatAt }));
          const scan = listFixDispatchClaimsStrict(lockRoot), result = authority();
          log?.(`${branch} ${state}: ${JSON.stringify(result)} unreadable=${scan.unreadable}`);
          if (scan.unreadable || !result.ok) violations.push(`${branch} ${state}: ${JSON.stringify(result)}`);
        }
        // Readable evidence must still bind authority to the branch's actual holder.
        writeFileSync(file, JSON.stringify({ ...neighbor, meta: { ...neighbor.meta, branch: 'lane/fix' } }));
        if (authority().code !== 'foreign-claim') violations.push('Same-branch foreign claim was not refused');
      } finally { rmSync(lockRoot, { recursive: true, force: true }); }
    }
    return { violations };
  },
  judge: report => report.violations,
};
