/**
 * @file breaks/ready-candidate-auto-retired-overlay-graduated.mjs — live break, 2026-11-04 ET on `wev-fix-daemon`.
 * A smoke-passed ready candidate (lane/fresh-plan-read-r3) was recorded by a rebuild job, but adoption would have
 * discarded it as `superseded-omits-live-overlay: lane/author-lookup-defer-m2`: that overlay had been retired by an
 * `auto-retired` event (PR merged, content in main), a kind `overlayGraduated` did not recognise, so the running
 * build's "live" overlay looked lost. The daemon stayed on a stale build.
 *
 * Fix: an `auto-retired` event (pr-merged/in-main, tip equal to the live sha, evidence contentInMain + cleanMerges,
 * recorded before the candidate passed) counts as graduated, still subject to the merge-tree tree-equality proof.
 * Anything short of that proof still discards.
 *
 * Scenario: real `matchReadyCandidate` + `overlayGraduated` from the tree under test with a stub git whose merge
 * tree equals the build tree (content in build). PRE-fix the proven case is discarded; FIXED it is adopted, while
 * forged/mismatched/late events are still discarded.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

export default {
  id: 'ready-candidate-auto-retired-overlay-graduated',
  title: 'a smoke-passed ready candidate was discarded as superseded-omits-live-overlay because the omitted overlay was retired by an auto-retired event overlayGraduated did not recognise — the daemon never adopted the build',
  card: 'fix-adopt-ready-candidate (lane/fix-adopt-ready-candidate)',
  fixedBy: { sha: '62949d08db', where: 'lane/fix-adopt-ready-candidate', paths: ['scripts/lib/daemon-rebuild/adopt.mjs'] },
  fixPresent(root) {
    const p = join(root, 'scripts/lib/daemon-rebuild/adopt.mjs');
    return existsSync(p) && /auto-retired/.test(readFileSync(p, 'utf8'));
  },
  async run({ log } = {}) {
    const root = REPO_ROOT;
    const { matchReadyCandidate, overlayGraduated } = await import(pathToFileURL(join(root, 'scripts/lib/daemon-rebuild/adopt.mjs')).href);
    const violations = [];
    const t0 = Date.parse('2026-11-04T21:52:24.136Z');
    const TREE = 'a'.repeat(40);
    const git = (args) => {
      if (args[0] === 'config') return { status: 1, stdout: '' };
      if (args[0] === 'rev-parse') return { status: 0, stdout: `${TREE}\n` };
      if (args[0] === 'merge-tree') return { status: 0, stdout: `${TREE}\n` };
      return { status: 1, stdout: '' };
    };
    const SHA = 'b97340164a826e1c25553bb9a5ae53f10c98968a';
    const REF = 'lane/author-lookup-defer-m2';
    const retired = (over = {}) => ({
      at: '2026-11-04T20:11:35.508Z', kind: 'auto-retired', ref: REF, reason: 'pr-merged', tip: SHA,
      evidence: { cleanMerges: true, contentInMain: true }, ...over,
    });
    const ready = {
      kind: 'candidate', prevHead: 'H', tree: 'T1', passedAt: new Date(t0).toISOString(),
      adopt: { finalSha: 'S1', inputsKey: 'K1', mainSha: 'M1', applied: [] },
    };
    const m = (events) => matchReadyCandidate({
      ready, plan: { finalSha: 'S2', inputsKey: 'K2', mainSha: 'M2', applied: [] }, prevHead: 'H',
      treeOf: () => 'T2', stillWanted: () => true, verifyBuilt: () => true,
      liveApplied: [{ ref: REF, sha: SHA }], carries: () => false,
      leftForMain: (a) => overlayGraduated({ ref: a.ref, sha: a.sha, build: 'S1', registered: () => false, events, git, readyAt: ready.passedAt }),
      nowMs: t0 + 60_000, maxAgeMs: 3_600_000,
    });
    const proven = m([retired()]);
    log?.(`auto-retired with proof -> adopt=${!!proven.adopt} reason=${proven.reason ?? ''}`);
    if (!proven.adopt) violations.push({ invariant: 'retired-overlay-discards-candidate', detail: `smoke-passed candidate discarded though the omitted overlay was retired with proof: ${proven.reason}` });
    for (const [name, ev] of [
      ['other-tip', retired({ tip: 'f'.repeat(40) })],
      ['no-content-proof', retired({ evidence: { cleanMerges: true, contentInMain: false } })],
      ['late', retired({ at: '2026-11-04T23:00:00.000Z' })],
      ['bad-reason', retired({ reason: 'pr-closed' })],
    ]) {
      if (m([ev]).adopt) violations.push({ invariant: 'unproven-retirement-adopted', detail: `candidate adopted on a ${name} retirement event` });
    }
    if (m([]).adopt) violations.push({ invariant: 'unproven-retirement-adopted', detail: 'candidate adopted with no retirement event' });
    return { violations };
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
