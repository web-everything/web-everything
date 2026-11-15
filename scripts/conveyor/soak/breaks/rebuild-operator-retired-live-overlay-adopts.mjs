/**
 * @file breaks/rebuild-operator-retired-live-overlay-adopts.mjs — live operator-retirement incident.
 * A live-applied overlay was removed through the sanctioned operation with a reason, but a verified rebuild
 * omitting it was discarded as `superseded-omits-live-overlay`. Intentional retirement of the exact live tip
 * must permit adoption and report the retired ref; removal without that evidence must still discard.
 *
 * Scenario: real `removeRegistration` records the removal, then real `overlayRetiredByOperator` supplies the
 * `retiredByOperator` predicate to `matchReadyCandidate`. PRE-fix the proven case discards; FIXED it adopts,
 * while missing-tip and missing-record cases still discard.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

export default {
  id: 'rebuild-operator-retired-live-overlay-adopts',
  title: 'a verified rebuild omitting a reasoned operator-retired live overlay adopts with retired refs, while missing retirement proof still discards',
  card: 'operator-retirement live incident (rebuild adoption)',
  fixedBy: { sha: '900a16b90b', where: 'main', paths: ['scripts/lib/daemon-rebuild/adopt.mjs', 'scripts/daemon-overlay.mjs'] },
  fixPresent(root) {
    const p = join(root, 'scripts/lib/daemon-rebuild/adopt.mjs');
    return existsSync(p) && /export function overlayRetiredByOperator/.test(readFileSync(p, 'utf8'));
  },
  async run({ log } = {}) {
    const root = REPO_ROOT;
    const { matchReadyCandidate, overlayRetiredByOperator } = await import(pathToFileURL(join(root, 'scripts/lib/daemon-rebuild/adopt.mjs')).href);
    const { removeRegistration } = await import(pathToFileURL(join(root, 'scripts/daemon-overlay.mjs')).href);
    const { addOverlay, appendOverlayEvent, readOverlays } = await import(pathToFileURL(join(root, 'scripts/lib/daemon-overlays.mjs')).href);
    const { readOverlayEventLog } = await import(pathToFileURL(join(root, 'scripts/lib/daemon-rebuild/prepare.mjs')).href);
    const violations = [];
    const t0 = Date.parse('2026-11-15T10:00:00Z');
    const ref = 'lane/operator-retired-overlay';
    const sha = 'a'.repeat(40);
    const reason = 'retire the live overlay';
    const ready = {
      kind: 'candidate', prevHead: 'H', tree: 'T1', passedAt: new Date(t0).toISOString(),
      adopt: { finalSha: 'S1', inputsKey: 'K1', mainSha: 'M1', applied: [] },
    };
    const scratch = mkdtempSync(join(tmpdir(), 'operator-retirement-soak-'));
    const env = { ...process.env, WE_DAEMON_OVERLAY_DIR: join(scratch, 'overlays') };
    try {
      addOverlay(scratch, { ref }, { env });
      appendOverlayEvent(scratch, { kind: 'added', ref, at: '2026-11-14T10:00:00Z' }, { env });
      const removal = removeRegistration({ root: scratch, ref, by: 'operator', reason, env, deps: { tip: () => sha } });
      const events = readOverlayEventLog(scratch, env);
      const removed = events.at(-1);
      if (!removal.removed || removed?.kind !== 'removed' || removed.ref !== ref || removed.tip !== sha || removed.reason !== reason) {
        violations.push({ invariant: 'sanctioned-removal-missing-proof', detail: 'reasoned removal did not record the exact live tip' });
      }
      const m = (history) => matchReadyCandidate({
        ready, plan: { finalSha: 'S2', inputsKey: 'K2', mainSha: 'M2', applied: [] }, prevHead: 'H',
        treeOf: () => 'T2', stillWanted: () => true, verifyBuilt: () => true,
        liveApplied: [{ ref, sha }], carries: () => false,
        retiredByOperator: (a) => overlayRetiredByOperator?.({ ...a, events: history,
          registered: (r) => readOverlays(scratch, { env }).some((o) => o.ref === r) }) ?? false,
        nowMs: t0 + 60_000, maxAgeMs: 3_600_000,
      });
      const proven = m(events);
      log?.(`operator-retired exact live tip -> adopt=${!!proven.adopt} reason=${proven.reason ?? ''}`);
      if (proven.adopt !== ready.adopt || proven.match !== 'superseded'
        || proven.retired?.length !== 1 || proven.retired[0] !== ref) {
        violations.push({ invariant: 'operator-retired-overlay-discarded', detail: `verified candidate must adopt with retired:[ref]: ${JSON.stringify(proven)}` });
      }
      for (const [name, history] of [
        ['missing-tip', events.map((e) => e.kind === 'removed' ? { ...e, tip: undefined } : e)],
        ['missing-removal-record', events.filter((e) => e.kind !== 'removed')],
        ['missing-history', []],
      ]) {
        const result = m(history);
        if (result.adopt !== null || result.reason !== `superseded-omits-live-overlay: ${ref}`
          || result.omitted?.length !== 1 || result.omitted[0] !== ref || result.retired?.length) {
          violations.push({ invariant: 'unproven-retirement-adopted', detail: `${name} must keep the live-overlay omission refusal: ${JSON.stringify(result)}` });
        }
      }
      return { violations };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
