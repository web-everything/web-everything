/** R918 / PR #6732: audit revocation must be checked for the tip actually being adopted. */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchReadyCandidate } from '../../../lib/daemon-rebuild/adopt.mjs';
import { makeAuditedTipGate } from '../../../lib/daemon-rebuild/audited-tip.mjs';

export default {
  id: 'ready-candidate-audit-revoked',
  title: 'pending candidates recheck their own audit evidence even when the live alert names a later tip',
  card: 'PR #6732 / R918',
  fixedBy: { sha: 'lane/overlay-pin-audited-sha', where: 'lane/overlay-pin-audited-sha', paths: ['scripts/lib/daemon-rebuild/adopt.mjs'] },
  fixPresent(root) {
    try { return readFileSync(join(root, 'scripts/lib/daemon-rebuild/adopt.mjs'), 'utf8').includes('const revokedExact = revokedAudit(ready.adopt)'); }
    catch { return false; }
  },
  async run() {
    const dir = mkdtempSync(join(tmpdir(), 'soak-ready-audit-'));
    const violations = [];
    try {
      const path = join(dir, 'ready.jsonl');
      const platform = join(dir, 'platform.json');
      writeFileSync(platform, '{}');
      const env = { WE_DAEMON_OVERLAY_FOLLOW_TIP: 'audited-only', WE_FIX_READY_PATH: path, WE_PLATFORM_PREFERENCES_FILE: platform };
      const ref = 'lane/moving';
      const row = (sha, tests = 'green') => JSON.stringify({ ref, sha, tests, audit: 'NOT WEAKENED' }) + '\n';
      const built = { finalSha: 'build-B', mainSha: 'M2', inputsKey: 'B', applied: [{ ref, sha: 'B' }] };
      const ready = { kind: 'candidate', prevHead: 'adopted-A-on-M1', passedAt: new Date(1000).toISOString(), tree: 'tree-B', adopt: built };
      for (const match of ['exact', 'same-tree', 'superseded', 'fallback', 'fallback-main-moved']) {
        writeFileSync(path, row('A') + row('B'));
        const gateBeforeRevocation = makeAuditedTipGate(env);
        if (!gateBeforeRevocation(ref, 'B')) throw new Error('B must have green evidence before revocation');
        const plan = { ...built, finalSha: match === 'exact' ? built.finalSha : 'live-build', inputsKey: 'live', auditAdopted: [ref], alerts: [] };
        if (match === 'superseded' || match.startsWith('fallback')) {
          plan.applied = [{ ref, sha: 'A', pinnedFrom: 'C' }];
          plan.alerts = [{ kind: 'overlay-unaudited-tip', detail: { ref, newTip: 'C' } }];
        }
        const candidate = match.startsWith('fallback')
          ? { ...ready, kind: 'fallback', forInputsKey: match === 'fallback' ? 'live' : 'older', dropRefs: [] }
          : ready;
        const options = {
          ready: candidate, plan, prevHead: ready.prevHead, nowMs: 2000, maxAgeMs: 10000,
          treeOf: () => match === 'same-tree' ? 'tree-B' : 'tree-A', stillWanted: () => true,
          verifyBuilt: () => true, liveApplied: [],
        };
        const green = matchReadyCandidate({ ...options, auditedTip: makeAuditedTipGate(env) });
        if (green.match !== match) throw new Error(`fixture did not reach ${match}: ${JSON.stringify(green)}`);
        appendFileSync(path, row('B', 'red'));
        const result = matchReadyCandidate({ ...options, auditedTip: makeAuditedTipGate(env) });
        if (result.adopt || result.reason !== 'ready-audit-revoked') {
          violations.push({ invariant: 'revoked-tip-adopted', detail: `${match}: ${JSON.stringify(result)}` });
        }
      }
      return { violations };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge(report) { return report.violations.map(v => `[${v.invariant}] ${v.detail}`); },
};
