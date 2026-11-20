/** R1075: a stuck daemon can load receipt-proven fixes, and a later smoke refusal withdraws them. */
import fs from 'node:fs';
import { join } from 'node:path';
import { assessDegraded } from '../../../operations/degraded-daemon.mjs';
import { checkDegradedFailures } from '../../../operations/degraded-load-rollback.mjs';
import { recordPendingAdoption, readPendingAdoptions } from '../../../lib/overlay-adoption.mjs';
import { appendDaemonEvent } from '../../../lib/daemon-events.mjs';
import { overlayFilePath, readOverlayState } from '../../../lib/daemon-overlays.mjs';
import { alertsFilePath } from '../../../lib/daemon-rebuild/state.mjs';
import { withBareOrigin } from '../../../operations/__tests__/helpers/real-repo.mjs';

const now = Date.parse('2026-11-18T12:00:00Z'), ref = 'lane/daemon-repair';
const signal = { kind: 'ready-candidate-discarded', daemon: 'control', at: new Date(now - 7200000).toISOString() };
export default {
  id: 'degraded-daemon-fast-path',
  title: 'degraded daemon evidence stays daemon-scoped and later smoke refusal retires the failed registration',
  card: 'R1075',
  fixedBy: { sha: 'HEAD', where: 'R1075', paths: ['scripts/operations/degraded-daemon.mjs', 'scripts/operations/degraded-load-rollback.mjs'] },
  fixPresent() {
    return assessDegraded({ events: [signal], daemon: 'control', clone: 'wev-control', now, afterMinutes: 60 }).degraded;
  },
  async run({ failure = 'smoke-rejected', retire, readState, failEventOnce = false, adopted = false, protection,
    refusalDetail, expectRefusal = true } = {}) {
    return withBareOrigin(async repo => {
      const dir = repo.tmp;
      const violations = [];
      const root = repo.clone;
      repo.seedOriginBranch(ref, { 'repair.mjs': 'export const repaired = true;\n' });
      repo.git(['fetch', 'origin']);
      const sha = repo.git(['rev-parse', `origin/${ref}`]).trim();
      const env = { ...process.env, HOME: dir, WE_DAEMON_EVENTS: join(dir, 'daemon-events.jsonl'),
        WE_DAEMON_OVERLAY_DIR: join(dir, 'overlays'), WE_DAEMON_STATE_DIR: join(dir, 'state'),
        WE_DAEMON_CLONE_LOCK_ROOT: join(dir, 'locks') };
      fs.writeFileSync(join(root, 'running-build'), 'previous-build');
      await appendDaemonEvent(signal, { env, now: () => new Date(signal.at) });
      const assessment = assessDegraded({ events: fs.readFileSync(env.WE_DAEMON_EVENTS, 'utf8'), daemon: 'control', clone: root, now, afterMinutes: 60 });
      if (!assessment.degraded) violations.push('old discard did not enable the fast path');
      const healthy = assessDegraded({ events: [signal], daemon: 'review', clone: join(dir, 'review'), now, afterMinutes: 60 });
      if (healthy.degraded) violations.push('foreign daemon signal enabled loading');
      fs.mkdirSync(env.WE_DAEMON_OVERLAY_DIR);
      const overlays = [{ ref, addedAt: new Date(now).toISOString(),
        ...(protection === 'pinned' ? { pinned: true } : {}),
        ...(protection === 'edge' ? { edgeResolution: { sha, by: 'operator' } } : {}) }];
      if (['stacked', 'uncached-stack'].includes(protection)) {
        repo.seedOriginBranch('lane/dependent', { 'dependent.mjs': 'export const dependent = true;\n' }, ref);
        overlays.push({ ref: 'lane/dependent', ...(protection === 'stacked' ? { stackBases: [ref] } : {}) });
      }
      fs.writeFileSync(overlayFilePath(root, env), JSON.stringify({ clone: root, overlays }));
      const fastPath = { ...assessment.evidence, branch: ref, sha, daemon: 'control', marker: { sig: 'receipt-marker' } };
      if (!recordPendingAdoption(root, { ref, sha, nonce: 'load-1', at: new Date(now).toISOString(), degradedFastPath: fastPath }, { env }))
        violations.push('pending fast-path evidence was not persisted');
      if (protection === 'moved-tip') repo.seedOriginBranch(ref, { 'later.mjs': 'export const later = true;\n' }, ref);
      const result = { adopted, moved: adopted, reason: failure, plan: { applied: [{ ref, sha }] }, alerts: failure === 'ready-candidate-discarded'
        ? [{ kind: failure, detail: refusalDetail ? refusalDetail({ ref, sha }) : { refs: [ref], reason: 'superseded-omits-live-overlay' } }] : [] };
      let eventAttempts = 0, pendingAfterFailedEvent;
      const check = () => checkDegradedFailures({ root, result, env, now: () => now + 1000,
        emit: async (event, opts) => {
          eventAttempts++;
          return failEventOnce && eventAttempts === 1 ? false : appendDaemonEvent(event, opts);
        },
        // Real retirement planner and guarded registry transaction; only GitHub is hermetic.
        ghArgs: args => args[0] === 'repo'
          ? { code: 0, stdout: JSON.stringify({ nameWithOwner: repo.slug, url: `https://github.com/${repo.slug}` }) }
          : args[0] === 'pr' && args[1] === 'list' ? { code: 0, stdout: JSON.stringify(protection === 'open-pr'
            ? [{ number: 1, state: 'OPEN', headRefName: ref, isCrossRepository: false }] : []) } : { code: 1, stdout: '' },
        ...(retire ? { retire } : {}), ...(readState ? { readState } : {}) });
      await check();
      if (failEventOnce) {
        pendingAfterFailedEvent = readPendingAdoptions(root, { env }).length;
        await check();
      }
      const remains = readOverlayState(root, { env }).overlays.some(r => r.ref === ref);
      const protectedRegistration = protection && protection !== 'open-pr';
      if (expectRefusal && !adopted && !retire && !readState && !protectedRegistration && remains) violations.push('failed candidate registration remained');
      if (expectRefusal && !adopted && !retire && !readState && !protectedRegistration && readPendingAdoptions(root, { env }).length) violations.push('retired candidate retained pending tracking');
      if (!expectRefusal && !remains) violations.push('unrelated refusal withdrew the pending registration');
      if (!expectRefusal && readPendingAdoptions(root, { env }).length !== 1) violations.push('unrelated refusal cleared pending tracking');
      if (protectedRegistration && !remains) violations.push('protected registration was withdrawn');
      if (fs.readFileSync(join(root, 'running-build'), 'utf8') !== 'previous-build') violations.push('previous build changed');
      const events = fs.readFileSync(env.WE_DAEMON_EVENTS, 'utf8').trim().split('\n').map(JSON.parse);
      if (expectRefusal && !adopted && !events.some(e => e.kind === 'prototype-load.degraded-fast-path-failed' && e.detail?.marker?.sig === 'receipt-marker'))
        violations.push('failure event lost evidence or receipt');
      const alertsPath = alertsFilePath(root, env);
      const alerts = fs.existsSync(alertsPath) ? fs.readFileSync(alertsPath, 'utf8') : '';
      if (expectRefusal && !adopted && !alerts.includes('NEEDS-YOU')) violations.push('failure did not escalate NEEDS-YOU');
      return { violations, remains, events, alerts, pendingAfterFailedEvent, eventAttempts };
    });
  },
  judge: report => report.violations,
};
