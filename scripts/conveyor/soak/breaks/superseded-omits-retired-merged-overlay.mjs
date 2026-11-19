/**
 * A ready build omitted a now-unregistered, merged overlay but contained its content. The retirement
 * happened in an earlier tick, so checking only this tick's removals discarded the candidate forever.
 * Replay the real prepare callback and adoption matcher, without ancestry or operator-retirement proof.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export default {
  id: 'superseded-omits-retired-merged-overlay',
  title: 'a superseded candidate preserves a historically retired merged overlay through content proof',
  card: 'historically retired merged overlay adoption',
  fixedBy: {
    sha: '27514e7d9c', where: 'working tree',
    paths: ['scripts/lib/daemon-rebuild/prepare.mjs', 'scripts/lib/daemon-rebuild/adopt.mjs'],
  },
  fixPresent(root) {
    try {
      const source = readFileSync(join(root, 'scripts/lib/daemon-rebuild/prepare.mjs'), 'utf8');
      return source.includes('Historical merge retirement')
        && source.includes('readOverlayEvents().findLast') && source.includes('last.tip !== sha');
    } catch { return false; }
  },
  async run({ sourceRoot, log, prepareSource } = {}) {
    const root = sourceRoot ?? resolve(fileURLToPath(import.meta.url), '../../../../..');
    const { matchReadyCandidate } = await import(pathToFileURL(join(root, 'scripts/lib/daemon-rebuild/adopt.mjs')).href);
    const source = prepareSource ?? readFileSync(join(root, 'scripts/lib/daemon-rebuild/prepare.mjs'), 'utf8');
    // Execute the production callback with its closed-over IO injected. Copying its logic here would
    // leave this break green when prepare regresses to considering only current-tick removals.
    const callback = source.match(/removedForMain:\s*(\(ref, sha\) => \{[\s\S]*?)\n        \},/);
    if (!callback) return { violations: ['removedForMain callback missing or unreadable'], results: [] };
    const makeRemovedForMain = new Function('plan', 'registeredRefs', 'overlaysBefore', 'readOverlayEvents', 'ready',
      `return (${callback[1]}\n});`);
    const ref = 'lane/merged-overlay';
    const sha = 'a'.repeat(40);
    const ready = {
      kind: 'candidate', prevHead: 'live-head', tree: 'candidate-tree',
      passedAt: '2026-11-18T12:02:00Z',
      adopt: { finalSha: 'candidate-build', mainSha: 'main-before', inputsKey: 'old-inputs', applied: [] },
    };
    // This historical producer supplied neither evidence nor an actor. Content proof is independent.
    const retirement = { ref, tip: sha, kind: 'auto-retired', reason: 'PR #123 merged into main', at: '2026-11-18T12:01:00Z' };
    const plan = { finalSha: 'new-plan', mainSha: 'main-now', inputsKey: 'new-inputs', applied: [], decisions: [] };
    const cases = [
      { name: 'historical merged retirement with candidate content', adopt: true },
      { name: 'negated reason', event: { reason: 'PR content is not in main' } },
      { name: 'missing content proof', content: false },
      { name: 'wrong live tip', event: { tip: 'b'.repeat(40) } },
      { name: 'still registered', registered: true },
      { name: 'registered before this tick', before: [{ ref }] },
      { name: 'later lifecycle event', later: { ref, kind: 'added', tip: sha } },
      { name: 'missing history', missing: true },
      { name: 'unknown reason', event: { reason: 'registration removed' } },
      { name: 'explicit negative evidence', event: { evidence: { contentInMain: false } } },
      { name: 'retirement at smoke time', event: { at: ready.passedAt } },
      { name: 'retirement after smoke', event: { at: '2026-11-18T12:03:00Z' } },
      { name: 'unreadable retirement time', event: { at: 'unknown' } },
    ];
    const violations = [];
    const results = [];
    for (const c of cases) {
      const events = c.missing ? [] : [{ ...retirement, ...c.event }, ...(c.later ? [c.later] : [])];
      const removedForMain = makeRemovedForMain(plan, new Set(c.registered ? [ref] : []), c.before ?? [], () => events, ready);
      const result = matchReadyCandidate({
        ready, plan, prevHead: ready.prevHead, treeOf: () => 'different-tree', stillWanted: () => false,
        verifyBuilt: () => true, liveApplied: [{ ref, sha }],
        carries: () => false, leftForMain: () => false, retiredByOperator: () => false,
        removedForMain,
        contentInBuild: (tip, build) => c.content !== false && tip === sha && build === ready.adopt.finalSha,
        nowMs: Date.parse('2026-11-18T12:03:00Z'), maxAgeMs: 600_000,
      });
      results.push({ name: c.name, result });
      log?.(`${c.name}: ${result.match ?? result.reason}`);
      const valid = c.adopt
        ? result.adopt === ready.adopt && result.match === 'superseded' && result.retired?.includes(ref)
        : result.adopt === null && result.reason === `superseded-omits-live-overlay: ${ref}`;
      if (!valid) violations.push(`${c.name}: ${JSON.stringify(result)}`);
    }
    return { violations, results };
  },
  judge(report) { return report.violations; },
};
