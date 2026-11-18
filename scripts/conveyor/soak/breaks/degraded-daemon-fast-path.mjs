/** R1075: a stuck daemon can load receipt-proven fixes, and a later smoke refusal withdraws them. */
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assessDegraded } from '../../../operations/degraded-daemon.mjs';
import { checkDegradedFailures } from '../../../operations/degraded-load-rollback.mjs';
import { recordPendingAdoption, readPendingAdoptions } from '../../../lib/overlay-adoption.mjs';
import { appendDaemonEvent } from '../../../lib/daemon-events.mjs';
import { overlayFilePath, readOverlayState } from '../../../lib/daemon-overlays.mjs';
import { alertsFilePath } from '../../../lib/daemon-rebuild/state.mjs';

const now = Date.parse('2026-11-18T12:00:00Z'), sha = 'a'.repeat(40), ref = 'lane/daemon-repair';
const signal = { kind: 'ready-candidate-discarded', daemon: 'wev-control', at: new Date(now - 7200000).toISOString() };
export default {
  id: 'degraded-daemon-fast-path',
  title: 'degraded daemon evidence stays daemon-scoped and later smoke refusal retires the failed registration',
  card: 'R1075',
  fixedBy: { sha: 'HEAD', where: 'R1075', paths: ['scripts/operations/degraded-daemon.mjs', 'scripts/operations/degraded-load-rollback.mjs'] },
  fixPresent() {
    return assessDegraded({ events: [signal], daemon: 'control', clone: 'wev-control', now, afterMinutes: 60 }).degraded;
  },
  async run({ failure = 'smoke-rejected', retire, readState, failEventOnce = false, adopted = false } = {}) {
    const dir = fs.mkdtempSync(join(tmpdir(), 'soak-degraded-daemon-'));
    const violations = [];
    try {
      const root = join(dir, 'wev-control');
      const env = { HOME: dir, WE_DAEMON_EVENTS: join(dir, 'daemon-events.jsonl'),
        WE_DAEMON_OVERLAY_DIR: join(dir, 'overlays'), WE_DAEMON_STATE_DIR: join(dir, 'state'),
        WE_DAEMON_CLONE_LOCK_ROOT: join(dir, 'locks') };
      fs.mkdirSync(root);
      fs.writeFileSync(join(root, 'running-build'), 'previous-build');
      await appendDaemonEvent(signal, { env, now: () => new Date(signal.at) });
      const assessment = assessDegraded({ events: fs.readFileSync(env.WE_DAEMON_EVENTS, 'utf8'), daemon: 'control', clone: root, now, afterMinutes: 60 });
      if (!assessment.degraded) violations.push('old discard did not enable the fast path');
      const healthy = assessDegraded({ events: [signal], daemon: 'review', clone: join(dir, 'review'), now, afterMinutes: 60 });
      if (healthy.degraded) violations.push('foreign daemon signal enabled loading');
      fs.mkdirSync(env.WE_DAEMON_OVERLAY_DIR);
      fs.writeFileSync(overlayFilePath(root, env), JSON.stringify({ clone: root, overlays: [{ ref, addedAt: new Date(now).toISOString() }] }));
      const fastPath = { ...assessment.evidence, branch: ref, sha, daemon: 'control', marker: { sig: 'receipt-marker' } };
      if (!recordPendingAdoption(root, { ref, sha, nonce: 'load-1', at: new Date(now).toISOString(), degradedFastPath: fastPath }, { env }))
        violations.push('pending fast-path evidence was not persisted');
      const result = { adopted, moved: adopted, reason: failure, plan: { applied: [{ ref, sha }] }, alerts: failure === 'ready-candidate-discarded'
        ? [{ kind: failure, detail: { refs: [ref], reason: 'superseded-omits-live-overlay' } }] : [] };
      let eventAttempts = 0, pendingAfterFailedEvent;
      const check = () => checkDegradedFailures({ root, result, env, now: () => now + 1000,
        emit: async (event, opts) => {
          eventAttempts++;
          return failEventOnce && eventAttempts === 1 ? false : appendDaemonEvent(event, opts);
        },
        git: () => ({ code: 0, stdout: sha }), tip: () => sha, ...(retire ? { retire } : {}), ...(readState ? { readState } : {}) });
      await check();
      if (failEventOnce) {
        pendingAfterFailedEvent = readPendingAdoptions(root, { env }).length;
        await check();
      }
      const remains = readOverlayState(root, { env }).overlays.some(r => r.ref === ref);
      if (!adopted && !retire && !readState && remains) violations.push('failed candidate registration remained');
      if (!adopted && !retire && !readState && readPendingAdoptions(root, { env }).length) violations.push('retired candidate retained pending tracking');
      if (fs.readFileSync(join(root, 'running-build'), 'utf8') !== 'previous-build') violations.push('previous build changed');
      const events = fs.readFileSync(env.WE_DAEMON_EVENTS, 'utf8').trim().split('\n').map(JSON.parse);
      if (!adopted && !events.some(e => e.kind === 'prototype-load.degraded-fast-path-failed' && e.detail?.marker?.sig === 'receipt-marker'))
        violations.push('failure event lost evidence or receipt');
      const alerts = adopted ? '' : fs.readFileSync(alertsFilePath(root, env), 'utf8');
      if (!adopted && !alerts.includes('NEEDS-YOU')) violations.push('failure did not escalate NEEDS-YOU');
      return { violations, remains, events, alerts, pendingAfterFailedEvent, eventAttempts };
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  },
  judge: report => report.violations,
};
