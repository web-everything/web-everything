/** A pinnedFrom exempts a held applied tip from audit revocation only when it is an audited exact 40-hex sha. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeAuditedTipGate, revokedAppliedTips } from '../../../lib/daemon-rebuild/audited-tip.mjs';

const SOURCE = 'scripts/lib/daemon-rebuild/audited-tip.mjs';
const ref = 'lane/pin', sha = 'a'.repeat(40), pin = 'b'.repeat(40);
export default {
  id: 'pinnedfrom-audited-exemption',
  title: 'an arbitrary or unaudited pinnedFrom no longer exempts a held tip; an audited 40-hex pin still does',
  card: 'pinnedfrom-audited',
  fixedBy: { sha: 'HEAD', where: 'lane/pinnedfrom-audited', paths: [SOURCE] },
  // Behavioural: decided by running the predicate, not by a marker string.
  fixPresent() { return this.run().violations.length === 0; },
  run() {
    const dir = mkdtempSync(join(tmpdir(), 'soak-pinnedfrom-'));
    const violations = [];
    try {
      const env = { WE_FIX_READY_PATH: join(dir, 'audited.jsonl'), WE_PLATFORM_PREFERENCES_FILE: join(dir, 'p.json'),
        WE_DAEMON_OVERLAY_FOLLOW_TIP: 'audited-only' };
      writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, '{}');
      writeFileSync(env.WE_FIX_READY_PATH, JSON.stringify({ ref, sha: pin, tests: 'green', audit: 'NOT WEAKENED' }) + '\n');
      const held = [{ detail: { ref, newTip: sha } }];
      const check = (pinnedFrom) => revokedAppliedTips({ applied: [{ ref, sha, pinnedFrom }],
        auditedTip: makeAuditedTipGate(env), auditAdopted: [ref], held });
      if (check('arbitrary').length !== 1) violations.push('an arbitrary pinnedFrom exempted a held tip');
      if (check('e'.repeat(40)).length !== 1) violations.push('an unaudited 40-hex pinnedFrom exempted a held tip');
      if (check(pin).length !== 0) violations.push('an audited 40-hex pinnedFrom lost its exemption');
      return { violations };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge(report) { return report.violations; },
};
