/**
 * @file breaks/rebuild-operator-retired-live-overlay-adopts.mjs — live operator-retirement incident.
 * A live-applied overlay was removed through the sanctioned operation with a reason, but a verified rebuild
 * omitting it was discarded as `superseded-omits-live-overlay`. Intentional retirement of the exact live tip
 * must permit adoption and report the retired ref; removal without that evidence must still discard.
 *
 * Scenario: real `withdrawUnregisteredOverlay` records the retirement, then real `overlayRetiredByOperator` supplies the
 * `retiredByOperator` predicate to `matchReadyCandidate`. PRE-fix the proven case discards; FIXED it adopts,
 * while missing-tip and missing-record cases still discard.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { REBUILD_IDENTITY_ENV } from '../../../lib/daemon-rebuild/shared.mjs';
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
    const { withdrawUnregisteredOverlay, retireRegistration } = await import(pathToFileURL(join(root, 'scripts/daemon-overlay.mjs')).href);
    const { addOverlay, appendOverlayEvent, readOverlays, removeOverlay } = await import(pathToFileURL(join(root, 'scripts/lib/daemon-overlays.mjs')).href);
    const { readOverlayEventLog } = await import(pathToFileURL(join(root, 'scripts/lib/daemon-rebuild/prepare.mjs')).href);
    const { OPERATOR_LOGINS } = await import(pathToFileURL(join(root, 'scripts/lib/marker-authorship.mjs')).href);
    const actor = OPERATOR_LOGINS[0];
    const violations = [];
    const t0 = Date.parse('2026-11-15T10:00:00Z');
    const ref = 'lane/operator-retired-overlay';
    const reason = 'retire the live overlay';
    const ready = {
      kind: 'candidate', prevHead: 'H', tree: 'T1', passedAt: new Date(t0).toISOString(),
      adopt: { finalSha: 'S1', inputsKey: 'K1', mainSha: 'M1', applied: [] },
    };
    const scratch = mkdtempSync(join(tmpdir(), 'operator-retirement-soak-'));
    const env = { ...process.env, ...REBUILD_IDENTITY_ENV, WE_DAEMON_OVERLAY_DIR: join(scratch, 'overlays') };
    const git = (...args) => {
      const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: scratch, env, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
      if (result.status !== 0) throw new Error(result.stderr || 'soak git fixture failed');
      return result.stdout.trim();
    };
    try {
      git('init', '-q', '-b', 'main');
      git('commit', '--allow-empty', '-qm', 'base');
      git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
      git('checkout', '-qb', ref);
      git('commit', '--allow-empty', '-qm', 'overlay');
      const sha = git('rev-parse', 'HEAD');
      git('checkout', '-q', 'main');
      git('merge', '--no-ff', '-m', `daemon-rebuild: merge overlay ${ref} onto main`, ref);
      addOverlay(scratch, { ref }, { env });
      appendOverlayEvent(scratch, { kind: 'added', ref, at: '2026-11-14T10:00:00Z' }, { env });
      removeOverlay(scratch, ref, { env });
      const removal = await withdrawUnregisteredOverlay({ reason, acceptOmission: true, root: scratch, ref, tip: sha, actor, env,
        deps: { resolveOperatorIdentity: () => ({ login: actor, type: 'User' }) } });
      const events = readOverlayEventLog(scratch, env);
      const removed = events.at(-1);
      if (!removal.retired || removed?.kind !== 'auto-retired' || removed.ref !== ref || removed.tip !== sha || removed.reason !== reason || removed.actor !== actor || removed.operatorReason !== true || removed.acceptedOmission !== true) {
        violations.push({ invariant: 'sanctioned-removal-missing-proof', detail: `reasoned removal did not record the exact live tip: ${JSON.stringify({ removal, event: removed })}` });
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
        ['removed-with-allowlisted-actor', events.map((e) => e.kind === 'auto-retired' ? { ...e, kind: 'removed' } : e)],
        ['missing-operator-authority', events.map((e) => e.kind === 'auto-retired' ? { ...e, operatorReason: undefined } : e)],
        ['automatic-in-main-with-actor', events.map((e) => e.kind === 'auto-retired' ? { ...e, reason: 'in-main' } : e)],
        ['missing-actor', events.map((e) => e.kind === 'auto-retired' ? { ...e, actor: undefined } : e)],
        ['non-operator-actor', events.map((e) => e.kind === 'auto-retired' ? { ...e, actor: 'unregistered[bot]' } : e)],
        ['missing-tip', events.map((e) => e.kind === 'auto-retired' ? { ...e, tip: undefined } : e)],
        ['missing-removal-record', events.filter((e) => e.kind !== 'auto-retired')],
        ['missing-history', []],
      ]) {
        const result = m(history);
        if (result.adopt !== null || result.reason !== `superseded-omits-live-overlay: ${ref}`
          || result.omitted?.length !== 1 || result.omitted[0] !== ref || result.retired?.length) {
          violations.push({ invariant: 'unproven-retirement-adopted', detail: `${name} must keep the live-overlay omission refusal: ${JSON.stringify(result)}` });
        }
      }
      addOverlay(scratch, { ref }, { env });
      await retireRegistration({ root: scratch, ref, expectedTip: sha, actor, env,
        deps: { prove: () => ({ action: 'retire', tip: sha, reason: 'in-main' }), tip: () => sha } });
      const automatic = readOverlayEventLog(scratch, env);
      if (m(automatic).adopt !== null)
        violations.push({ invariant: 'automatic-retirement-authorized-omission', detail: 'ordinary in-main retirement with operator attribution must refuse omission' });
      return { violations };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
