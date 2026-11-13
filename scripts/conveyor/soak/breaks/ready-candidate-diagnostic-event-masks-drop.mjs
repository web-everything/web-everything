/**
 * @file breaks/ready-candidate-diagnostic-event-masks-drop.mjs — live break, 2026-11-13.
 * An auto-dropped in-main overlay was followed by diagnostic events (overlay-main-red / needs-you).
 * overlayGraduated treated the last diagnostic as lifecycle evidence, masking the drop and discarding a
 * smoke-passed ready candidate as superseded-omits-live-overlay.
 *
 * Fix: diagnostics dated <= readyAt do not mask the drop; later or unreadable diagnostics still veto.
 * Unknown kinds, including unknown overlay-* kinds, remain lifecycle evidence and fail closed.
 * Scenario: real matchReadyCandidate + overlayGraduated with a stub git proving content in the build,
 * exactly as in ready-candidate-auto-retired-overlay-graduated. Pre-fix the proven cases discard.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

export default {
  id: 'ready-candidate-diagnostic-event-masks-drop',
  title: 'a diagnostic after an in-main auto-drop masked graduation and discarded a smoke-passed ready candidate as superseded-omits-live-overlay',
  card: 'ready-candidate diagnostic masks drop (#6745 stuck daemon)',
  fixedBy: { sha: 'd6ce8fc6fe,f32d39c2ab,2522a918d8,0a61e484af', where: 'main', paths: ['scripts/lib/daemon-rebuild/adopt.mjs'] },
  fixPresent(root) {
    const p = join(root, 'scripts/lib/daemon-rebuild/adopt.mjs');
    if (!existsSync(p)) return false;
    const source = readFileSync(p, 'utf8');
    return /!diagnostic\(event.kind\)/.test(source) && /timeMs\(event.at\) <= readyAtMs/.test(source);
  },
  async run({ log } = {}) {
    const { matchReadyCandidate, overlayGraduated } = await import(pathToFileURL(join(REPO_ROOT, 'scripts/lib/daemon-rebuild/adopt.mjs')).href);
    const violations = [];
    const t0 = Date.parse('2026-11-13T12:17:00.000Z');
    const TREE = 'c'.repeat(40);
    const SHA = 'a'.repeat(40);
    const REF = 'lane/fix-daemon-pr-budgets-m1';
    const git = (args) => {
      if (args[0] === 'config') return { status: 1, stdout: '' };
      if (args[0] === 'rev-parse' || args[0] === 'merge-tree') return { status: 0, stdout: `${TREE}\n` };
      return { status: 1, stdout: '' };
    };
    const drop = { kind: 'auto-dropped', ref: REF, reason: 'in-main', at: '2026-11-13T11:22:00.000Z' };
    const diagnostic = (kind, at = '2026-11-13T11:51:00.000Z') => ({ kind, ref: REF, at });
    const ready = {
      kind: 'candidate', prevHead: 'H', tree: 'T1', passedAt: new Date(t0).toISOString(),
      adopt: { finalSha: 'S1', inputsKey: 'K1', mainSha: 'M1', applied: [] },
    };
    const m = (events, contained = true) => matchReadyCandidate({
      ready, plan: { finalSha: 'S2', inputsKey: 'K2', mainSha: 'M2', applied: [] }, prevHead: 'H',
      treeOf: () => 'T2', stillWanted: () => true, verifyBuilt: () => true,
      liveApplied: [{ ref: REF, sha: SHA }], carries: () => false,
      leftForMain: (a) => overlayGraduated({
        ref: a.ref, sha: a.sha, build: 'S1', registered: () => false, events, readyAt: ready.passedAt,
        git: (args) => !contained && args[0] === 'merge-tree' ? { status: 0, stdout: `${'d'.repeat(40)}\n` } : git(args),
      }),
      nowMs: t0 + 60_000, maxAgeMs: 3_600_000,
    });
    for (const kind of [
      'overlay-main-red', 'overlay-main-test-selection', 'overlay-main-merge-conflict', 'overlay-main-synced',
      'overlay-main-sync-shadow', 'overlay-main-flaky-retried',
      'needs-you', 'quick-soak-needs-you', 'auto-rebase-needs-you', 'auto-retire-shadow',
    ]) {
      for (const at of ['2026-11-13T11:51:00.000Z', ready.passedAt]) {
        const result = m([drop, diagnostic(kind, at)]);
        log?.(`${kind} at ${at} -> adopt=${!!result.adopt} reason=${result.reason ?? ''}`);
        if (!result.adopt) violations.push({ invariant: 'diagnostic-masks-drop', detail: `${kind} at ${at} masked the in-main drop: ${result.reason}` });
      }
      for (const at of ['2026-11-13T12:17:00.001Z', 'unparseable', null]) {
        if (m([drop, diagnostic(kind, at)]).adopt) violations.push({ invariant: 'unseen-diagnostic-adopted', detail: `${kind} at ${at} did not veto graduation` });
      }
    }
    for (const [name, events, contained] of [
      ['no-drop', [diagnostic('overlay-main-red')]],
      ['other-ref-drop', [{ ...drop, ref: 'lane/other' }, diagnostic('needs-you')]],
      ['unknown-kind', [drop, diagnostic('some-future-kind'), diagnostic('needs-you')]],
      ['unknown-overlay-kind', [drop, diagnostic('overlay-future-lifecycle'), diagnostic('needs-you')]],
      ['re-added', [drop, diagnostic('added'), diagnostic('needs-you')]],
      ['no-content-proof', [drop, diagnostic('needs-you')], false],
      ['unparseable-drop', [{ ...drop, at: 'unparseable' }, diagnostic('needs-you')]],
      ['late-drop', [{ ...drop, at: ready.passedAt }, diagnostic('needs-you')]],
      ['missing-diagnostic-time', [drop, { kind: 'needs-you', ref: REF }]],
      ['late-diagnostic-before-drop-in-log', [diagnostic('needs-you', '2026-11-13T12:18:00.000Z'), drop]],
    ]) {
      const result = m(events, contained);
      if (result.adopt || result.reason !== `superseded-omits-live-overlay: ${REF}`) {
        violations.push({ invariant: 'unproven-graduation-adopted', detail: `${name}: adopt=${!!result.adopt} reason=${result.reason ?? ''}` });
      }
    }
    return { violations };
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
