/**
 * Live #6732 (2026-11-14): an operator send-back, then four fix rounds. Each fixer pushed its fix, idled on the verify of
 * the PR's current head, and was reclaimed ("CI owns that verdict") before verify finished, so the harness could not
 * resume the SAME fixer to post `## Fix evidence`. The reclaim must hold such a fixer while the send-back is open and
 * the lane's verify is still running within the verify TTL, and reclaim again once that TTL has passed.
 * Every production import follows `root`, so the same replay exercises the pre-fix tree.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const SOURCE = 'scripts/conveyor/fixer-stuck-reclaim.mjs';
const SID = '3eef58ae-4dfb-4793-9a59-feb04387a49a';
const HEAD = '14796a6ce0cd27065c62cf97788368c9473528e8';
const NOW = Date.parse('2026-11-14T10:39:00Z');
const EVENT = { type: 'session-watchdog.fixer-stuck', v: 1, key: `we#6732|${SID}|stalled|${HEAD}`, at: '2026-11-14T10:39:07Z',
  repo: 'we', pr: 6732, claimKind: 'fixing', session: { name: 'fix-6732', id: '3eef58ae', sessionId: SID }, classification: 'stalled', reason: 'idle', headSha: HEAD };
const CLAIM = { owner: 'fixer:fix-6732', meta: { kind: 'fixing', repo: 'we', pr: 6732, who: 'fix-6732', sessionId: SID } };
const AWAIT = { v: 1, sessionId: SID, who: 'fix-6732', pr: 6732, sha: HEAD, requestedAt: '2026-11-14T10:20:00Z', kind: 'fix' };

export default {
  id: 'send-back-fixer-reclaimed-before-verify',
  title: 'a fixer idle on the verify of the current head while an operator send-back is open is reclaimed before verify finishes',
  card: 'PR #6732 (send-back evidence loop)',
  fixedBy: { sha: 'a5d08facb9', where: 'lane/sendback-evidence-6732', paths: [SOURCE] },
  fixPresent: (root) => { try { return readFileSync(join(root, SOURCE), 'utf8').includes('sendBackOwedFor'); } catch { return false; } },
  async run({ root = ROOT } = {}) {
    const violations = [];
    const { planFixerStuckReclaim } = await import(pathToFileURL(join(root, SOURCE)).href);
    const base = { events: [EVENT], acked: new Set(), claims: [CLAIM], nowMs: NOW, awaitFor: () => AWAIT, prHeadFor: () => HEAD,
      lastActivityMsFor: () => Date.parse('2026-11-14T10:00:00Z') };
    const held = planFixerStuckReclaim({ ...base, sendBackOwedFor: () => true, verifyRunningFor: () => true })[0];
    if (held?.decision !== 'hold') violations.push(`open send-back + verify running: expected hold, got ${held?.decision} (${held?.reason})`);
    const stale = planFixerStuckReclaim({ ...base, sendBackOwedFor: () => true, verifyRunningFor: () => false })[0];
    if (stale?.decision !== 'reclaim') violations.push(`verify no longer running: expected reclaim, got ${stale?.decision}`);
    const none = planFixerStuckReclaim({ ...base, sendBackOwedFor: () => false, verifyRunningFor: () => true })[0];
    if (none?.decision !== 'reclaim') violations.push(`no open send-back: expected reclaim, got ${none?.decision}`);
    return { violations };
  },
  judge: (report) => report.violations,
};
