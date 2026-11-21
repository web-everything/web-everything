/** A stale fix claim must release when a readable listing proves its owner is gone. */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const CLAIMS = 'scripts/conveyor/fix-dispatch-claim.mjs';

async function probe(root) {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const claims = await import(pathToFileURL(join(root, 'scripts/conveyor/fix-dispatch-claim.mjs')).href);
  const nowMs = Date.parse('2026-11-20T12:00:00Z');
  const unrelated = [{ name: 'unrelated-agent', state: 'working', sessionId: 'other-session' }];
  const cases = [
    ['stale owner gone', 2 * 60 * 60_000, unrelated, true],
    ['five-minute listing lag', 5 * 60_000, unrelated, false],
    ['empty listing fails closed', 2 * 60 * 60_000, [], false],
  ];
  const violations = [];
  for (const [name, ageMs, listing, shouldRelease] of cases) {
    const lockRoot = mkdtempSync(join(tmpdir(), 'soak-stale-fix-claim-'));
    try {
      const key = { repo: 'we', pr: 7171, kind: 'fix', lockRoot };
      const events = [];
      claims.acquireFixDispatchClaim({ ...key, owner: 'soak-owner', sessionId: 'owner-session',
        nowMs: nowMs - ageMs, nowIso: new Date(nowMs - ageMs).toISOString() });
      if (!claims.readFixDispatchClaim(key)) {
        violations.push(`${name}: claim was not acquired`);
        continue;
      }
      claims.refreshLiveFixDispatchClaims({ lockRoot, listAgentsAll: () => listing,
        recordEvent: event => events.push(event), nowMs, nowIso: () => new Date(nowMs).toISOString(),
        awaitingVerifyFor: null, idleRelease: { enabled: false } });
      const released = claims.readFixDispatchClaim(key) === null;
      const releaseEvent = events.some(event => event.kind === 'stale-claim-released');
      if (released !== shouldRelease) violations.push(`${name}: claim ${shouldRelease ? 'not released' : 'not retained'}`);
      if (releaseEvent !== shouldRelease) violations.push(`${name}: ${shouldRelease ? 'no' : 'unexpected'} stale-claim-released event`);
    } finally {
      rmSync(lockRoot, { recursive: true, force: true });
    }
  }
  return { violations };
}

export default {
  id: 'stale-fix-claim-released-when-owner-gone',
  title: 'stale fix claims release when their owner is gone and retain uncertain owners',
  card: 'stale fix claim release',
  fixedBy: { sha: 'HEAD', where: 'working tree', paths: [CLAIMS] },
  fixPresent(root) {
    // Presence must stay true on behavioural regressions so run()/judge fails normally.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import(${JSON.stringify(pathToFileURL(resolve(root, CLAIMS)).href)}).then(m => process.exit(typeof m.STALE_GONE_GRACE_MS === 'number' && typeof m.refreshLiveFixDispatchClaims === 'function' ? 0 : 1)).catch(() => process.exit(1));`],
    { timeout: 15000, maxBuffer: 65536, encoding: 'utf8' });
    return !result.error && result.status === 0;
  },
  async run({ sourceRoot = ROOT } = {}) {
    return probe(sourceRoot);
  },
  judge: report => report.violations,
};
