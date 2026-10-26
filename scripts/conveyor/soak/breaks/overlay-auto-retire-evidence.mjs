/** PR #5964: retirement must honor explicit shadow and fresh per-ref evidence. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareRebuild } from '../../../lib/daemon-rebuild/prepare.mjs';
import { ACTIVE_BUILD_TOKENS, releaseBuildLease } from '../../../lib/daemon-rebuild/lease.mjs';
import { readRebuildState, writeRebuildState } from '../../../lib/daemon-rebuild/state.mjs';
import { overlayFilePath, readOverlayState, removeOverlay, writeOverlays } from '../../../lib/daemon-overlays.mjs';
import { autoRetireOverlays } from '../../../lib/daemon-overlay-auto-retire.mjs';

export default {
  id: 'overlay-auto-retire-evidence',
  title: 'stale overlays preserve registrations without blocking healthy rebuilds or repeating shadow audit',
  card: 'PR #5964',
  fixedBy: { sha: 'pr-5964-repair', where: 'lane/overlay-auto-retire', paths: [
    'scripts/lib/daemon-overlay-auto-retire.mjs', 'scripts/lib/daemon-rebuild/prepare.mjs',
    'scripts/lib/daemon-rebuild/edge-fetch.mjs', 'scripts/lib/daemon-overlays.mjs',
  ] },
  fixPresent(root) {
    try {
      return readFileSync(join(root, 'scripts/lib/daemon-overlay-auto-retire.mjs'), 'utf8').includes("r.sources.mode === 'tool'")
        && readFileSync(join(root, 'scripts/lib/daemon-rebuild/prepare.mjs'), 'utf8').includes('refEvidence: fetchResult.refEvidence')
        && readFileSync(join(root, 'scripts/lib/daemon-overlays.mjs'), 'utf8').includes('expectedRequiredOverlay');
    } catch { return false; }
  },
  async run() {
    const root = mkdtempSync(join(tmpdir(), 'overlay-retire-soak-'));
    const violations = [];
    const violation = (invariant, detail) => violations.push({ invariant, detail, daemon: 'rebuild', tick: 0 });
    const env = {
      WE_DAEMON_OVERLAY_DIR: join(root, 'store'), WE_DAEMON_STATE_DIR: join(root, 'state'),
      WE_DAEMON_EVENTS: join(root, 'events.jsonl'), WE_PLATFORM_PREFERENCES_FILE: join(root, 'prefs.json'),
      WE_DAEMON_AUTO_REBASE: '0', WE_DAEMON_OVERLAY_AUTO_RETIRE: 'shadow',
    };
    const git = (args) => spawnSync('git', ['-c', 'user.name=Soak', '-c', 'user.email=soak@example.test', ...args], {
      cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    const ok = (...args) => {
      const result = git(args);
      if (result.status !== 0) throw new Error(String(result.stderr));
      return String(result.stdout).trim();
    };
    const commit = (file) => {
      writeFileSync(join(root, file), file);
      ok('add', file); ok('commit', '-qm', file);
      return ok('rev-parse', 'HEAD');
    };
    const prepare = async (run = git) => {
      const prepared = await prepareRebuild({ root, env, run, now: Date.now, mainOnly: false,
        prState: async () => 'OPEN', prBaseChain: async () => [] });
      // These probes stop at planning. Cancel their build leases before the next probe, as rebuildClone
      // does on exit; otherwise a successful probe blocks the next one as rebuild-in-progress.
      if (prepared.lease) {
        try {
          const state = readRebuildState(root, env);
          releaseBuildLease(state, prepared.lease);
          writeRebuildState(root, state, env);
        } finally { ACTIVE_BUILD_TOKENS.delete(prepared.lease.token); }
      }
      return prepared;
    };
    try {
      writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, '{}');
      ok('init', '-q', '-b', 'main');
      const initial = commit('base');
      ok('update-ref', 'refs/remotes/origin/main', initial);
      const overlays = [{ ref: 'deleted', sha: initial }];
      writeOverlays(root, overlays, { env });
      const shadow = await autoRetireOverlays({ root, env, overlays, git, now: () => Date.parse('2026-10-29T12:00:00Z') });
      if (shadow.retired.length || readOverlayState(root, { env }).overlays.length !== 1) {
        violation('explicit-shadow-promoted', 'operator shadow removed a registration after the tool graduation date');
      }
      const auditFile = overlayFilePath(root, env).replace(/\.json$/, '.events.jsonl');
      const firstAudit = readFileSync(auditFile, 'utf8');
      await autoRetireOverlays({ root, env, overlays, git });
      if (readFileSync(auditFile, 'utf8') !== firstAudit) {
        violation('shadow-audit-unbounded', 'a second observation appended the same ref, sha and reason');
      }
      env.WE_DAEMON_OVERLAY_AUTO_RETIRE = 'on';
      ok('clone', '--bare', '-q', root, join(root, 'origin.git'));
      ok('remote', 'add', 'origin', join(root, 'origin.git'));
      writeOverlays(root, overlays, { env });
      const previousEvents = readFileSync(auditFile, 'utf8').trim().split('\n').length;
      for (const mode of ['off', 'shadow', 'on']) {
        env.WE_DAEMON_OVERLAY_AUTO_RETIRE = mode;
        writeOverlays(root, overlays, { env });
        const prepared = await prepare();
        if (prepared.result?.reason !== 'up-to-date') {
          violation('stale-registration-blocks-main', `${mode}: deleted landed registration blocked preparation (${prepared.result?.reason})`);
        }
      }
      const retiredEvents = readFileSync(auditFile, 'utf8').trim().split('\n').slice(previousEvents).map(JSON.parse);
      if (readOverlayState(root, { env }).overlays.length || !retiredEvents.some((e) => e.by === 'auto-retire' && e.ref === 'deleted')) {
        violation('deleted-landed-overlay-retained', 'a confirmed missing branch with a recorded main commit was not retired');
      }
      // A live remote branch whose fetch fails must not be retired using its stale cached main tip.
      ok('checkout', '-qb', 'feature');
      commit('feature');
      ok('push', '-q', 'origin', 'feature');
      ok('checkout', '-q', 'main');
      ok('update-ref', 'refs/remotes/origin/feature', initial);
      const uncertain = [{ ref: 'feature', sha: initial }];
      writeOverlays(root, uncertain, { env });
      const held = await prepare((args) => args[0] === 'fetch' && args.some((arg) => arg.includes('refs/heads/feature:'))
        ? { status: 1, stderr: 'transient fetch error' } : git(args));
      if (held.result?.reason !== 'up-to-date' || held.result?.plan?.decisions.length
        || !readOverlayState(root, { env }).overlays.some((o) => o.ref === 'feature')) {
        violation('failed-fetch-lost-registration', 'an unconfirmed overlay blocked main, used a cached tip or lost its registration');
      }
      // Containment was proved against this registration, then a different registration took its name.
      ok('checkout', '-qb', 'lower');
      const lower = commit('lower');
      ok('update-ref', 'refs/remotes/origin/lower', lower);
      const top = commit('top');
      ok('update-ref', 'refs/remotes/origin/top', top);
      const stack = [{ ref: 'lower', sha: lower }, { ref: 'top', sha: top }];
      writeOverlays(root, stack, { env });
      const replaced = await autoRetireOverlays({ root, env, overlays: stack, git,
        removeOverlay: (r, ref, opts) => {
          writeOverlays(root, [stack[0], { ref: 'top', sha: initial, addedAt: 'replacement' }], { env });
          return removeOverlay(r, ref, opts);
        },
      });
      if (replaced.retired.length || !readOverlayState(root, { env }).overlays.some((o) => o.ref === 'lower')) {
        violation('replaced-container-lost-source', 'the source was removed after its containing registration was replaced');
      }
      // Only lower is on origin. The recorded top contains it but cannot carry this rebuild.
      ok('push', '-q', 'origin', `${lower}:refs/heads/lower`);
      ok('checkout', '-q', 'main');
      writeOverlays(root, stack, { env });
      const available = await prepare();
      if (available.terminal || available.plan?.applied.map((o) => o.ref).join(',') !== 'lower'
        || !readOverlayState(root, { env }).overlays.some((o) => o.ref === 'lower')) {
        violation('missing-container-lost-available-source', 'a missing recorded top retired the refreshed lower overlay out of the rebuild');
      }
      ok('checkout', '-q', 'main');
      const nextMain = commit('main-advanced');
      ok('push', '-q', 'origin', 'main');
      ok('reset', '--hard', initial);
      const stale = [{ ref: 'missing-no-sha' }, { ref: 'unsafe@name' }, { ref: 'feature' }];
      writeOverlays(root, stale, { env });
      const healthy = await prepare();
      if (healthy.terminal || healthy.plan?.mainSha !== nextMain || healthy.plan?.applied.map((o) => o.ref).join(',') !== 'feature'
        || readOverlayState(root, { env }).overlays.length !== stale.length) {
        violation('single-stale-registration-blocks-healthy-overlay', `a deleted no-sha or unsafe registration stopped the healthy overlay plan (${healthy.result?.reason ?? 'non-terminal plan'})`);
      }
    } catch (error) { violation('crash', String(error?.message ?? error)); }
    finally { rmSync(root, { recursive: true, force: true }); }
    return { violations };
  },
  judge(report) { return report.violations.map((v) => `[${v.invariant}] ${v.detail}`); },
};
