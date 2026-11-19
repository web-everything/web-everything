/**
 * @file rebuild-adopt-then-add.mjs — live 2026-11-18 (review daemon). A rebuild candidate PASSED its ~20 minute smoke at
 * 17:28 ET and again at 18:06 ET, and was then discarded before adoption (`overlay-no-longer-wanted`,
 * `superseded-omits-live-overlay: lane/review-seat-fairness-m1`) because the overlay set moved while it smoked. It never adopted.
 *
 * Replay the real matcher: a smoke-passed build is adopted when an applied overlay left for a benign reason (PR merged, no
 * longer wanted) or when a live overlay it omits is still registered (adopt, then rebuild with it added). Controls: a removal for
 * failure/rollback/closed PR/security, an unknown or missing reason, and an omitted overlay a carried overlay depends on all
 * still discard the build.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const ADOPT = 'scripts/lib/daemon-rebuild/adopt.mjs';
const SHA = (c) => c.repeat(40);

const base = (over = {}) => ({
  ready: { kind: 'candidate', prevHead: 'live', passedAt: '2026-11-18T22:28:00Z', tree: 'ready-tree',
    adopt: { finalSha: SHA('f'), inputsKey: 'k', applied: [{ ref: 'lane/a', sha: SHA('a') }] } },
  plan: { finalSha: SHA('e'), inputsKey: 'k2', mainSha: SHA('1'), alerts: [], decisions: [] },
  prevHead: 'live', treeOf: () => 'plan-tree', stillWanted: () => true, verifyBuilt: () => true,
  nowMs: Date.parse('2026-11-18T22:50:00Z'), maxAgeMs: 3_600_000, liveApplied: [], ...over,
});
const gone = { stillWanted: (ref) => ref !== 'lane/a', registered: (ref) => ref !== 'lane/a' };
const omitsLive = { liveApplied: [{ ref: 'lane/review-seat-fairness-m1', sha: SHA('b') }], carries: () => false };

export const CASES = [
  { id: 'benign-removal-adopts', args: { ...gone, removalSafety: () => 'benign' }, adopts: true, rebuildAfter: ['lane/a'] },
  { id: 'unsafe-removal-discards', args: { ...gone, removalSafety: () => 'unsafe' }, adopts: false, reason: 'overlay-no-longer-wanted' },
  { id: 'unknown-removal-discards', args: { ...gone }, adopts: false, reason: 'overlay-no-longer-wanted' },
  { id: 'omitted-registered-overlay-adopts', args: { ...omitsLive, readdable: () => true }, adopts: true,
    rebuildAfter: ['lane/review-seat-fairness-m1'] },
  { id: 'omitted-unregistered-overlay-discards', args: { ...omitsLive }, adopts: false,
    reason: 'superseded-omits-live-overlay: lane/review-seat-fairness-m1' },
  { id: 'omitted-dependency-discards', args: { ...omitsLive, readdable: () => true, dependsOn: (ref) => (ref === 'lane/a' ? ['lane/review-seat-fairness-m1'] : []) },
    adopts: false, reason: 'superseded-omits-live-overlay: lane/review-seat-fairness-m1' },
];

/** Behavioural probe, run in a child so `fixPresent` stays synchronous. */
const PROBE = `
const { matchReadyCandidate } = await import(process.argv[1]);
const m = matchReadyCandidate({
  ready: { kind: 'candidate', prevHead: 'live', passedAt: '2026-11-18T22:28:00Z', tree: 'ready-tree',
    adopt: { finalSha: 'f'.repeat(40), inputsKey: 'k', applied: [{ ref: 'lane/a', sha: 'a'.repeat(40) }] } },
  plan: { finalSha: 'e'.repeat(40), inputsKey: 'k2', mainSha: '1'.repeat(40), alerts: [] },
  prevHead: 'live', treeOf: () => 'plan-tree', verifyBuilt: () => true, liveApplied: [],
  nowMs: Date.parse('2026-11-18T22:50:00Z'), maxAgeMs: 3600000,
  stillWanted: (r) => r !== 'lane/a', registered: (r) => r !== 'lane/a', removalSafety: () => 'benign',
});
console.log(m.adopt ? 'yes' : 'no');
`;

export default {
  id: 'rebuild-adopt-then-add',
  title: 'a smoke-passed rebuild candidate is adopted when the overlay set moved for a benign reason (adopt, then add)',
  card: 'live 2026-11-18: review daemon discarded two passing candidates (17:28 and 18:06 ET) and never adopted',
  fixedBy: { sha: 'pending', where: 'lane/rebuild-adopt-then-add', paths: [ADOPT, 'scripts/lib/daemon-rebuild/prepare.mjs'] },
  fixPresent(root) {
    try {
      const url = pathToFileURL(resolve(root, ADOPT)).href;
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', PROBE, url], { encoding: 'utf8', timeout: 20_000 });
      return out.trim() === 'yes';
    } catch { return false; }
  },
  async run({ log, sourceRoot = REPO_ROOT } = {}) {
    const violations = [];
    try {
      const { matchReadyCandidate } = await import(pathToFileURL(resolve(sourceRoot, ADOPT)).href);
      for (const c of CASES) {
        const m = matchReadyCandidate({ ...base(), ...c.args });
        log?.(`${c.id}: ${m.adopt ? 'adopt' : m.reason}`);
        const ok = c.adopts
          ? !!m.adopt && JSON.stringify([...(m.rebuildAfter ?? [])].sort()) === JSON.stringify(c.rebuildAfter)
          : !m.adopt && m.reason === c.reason;
        if (!ok) violations.push({ invariant: c.id, detail: `expected ${c.adopts ? 'adopt' : c.reason}, got ${m.adopt ? 'adopt' : m.reason}` });
      }
    } catch (e) {
      violations.push({ invariant: 'crash', detail: String(e?.message ?? e) });
    }
    return { violations };
  },
  judge(report) { return report.violations.map((v) => `[${v.invariant}] ${v.detail}`); },
};
