/** PR #6033: fallback smoke evidence cannot remove an unbound or replaced registration. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

async function replay(tree) {
  const load = (file) => import(pathToFileURL(join(tree, 'scripts/lib', file)).href);
  const { addOverlay, readOverlays, overlayFilePath, removeOverlay } = await load('daemon-overlays.mjs');
  const { dropSuspectOverlays, finalizeRebuild, matchReadyCandidate } = await load('daemon-rebuild/adopt.mjs');
  const violations = [];
  // Every CAS caller (rebuild retire/drop decisions too, whose snapshot can miss a ref) shares removeOverlay:
  // asking for the CAS with no usable token must refuse there, not only in the suspect-drop guard.
  for (const token of [undefined, null, '']) {
    const root = mkdtempSync(join(tmpdir(), 'suspect-cas-soak-'));
    const env = { WE_DAEMON_OVERLAY_DIR: join(root, 'overlays'), WE_DAEMON_STATE_DIR: join(root, 'state') };
    try {
      addOverlay(root, { ref: 'lane/suspect', pr: 17 }, { env });
      let refused = false;
      try { removeOverlay(root, 'lane/suspect', { env, why: 'smoke-failed', expectRegistrationId: token }); }
      catch (error) { refused = /registration changed/.test(String(error?.message)); }
      if (!refused || readOverlays(root, { env }).length !== 1) {
        violations.push(`shared CAS ${token === undefined ? 'undefined' : JSON.stringify(token)}: removed without a registration token`);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  for (const recovery of [false, true]) {
    for (const identity of ['missing', 'stale', 'matching']) {
      const root = mkdtempSync(join(tmpdir(), 'suspect-cas-soak-'));
      const env = { WE_DAEMON_OVERLAY_DIR: join(root, 'overlays'), WE_DAEMON_STATE_DIR: join(root, 'state') };
      try {
        const suspect = addOverlay(root, { ref: 'lane/suspect', pr: 17 }, { env })[0];
        if (identity === 'missing') delete suspect.registrationId;
        const current = identity === 'matching' ? suspect : addOverlay(root, { ref: suspect.ref, pr: suspect.pr }, { env })[0];
        const file = overlayFilePath(root, env);
        const before = readFileSync(file, 'utf8');
        const sha = 'a'.repeat(40);
        const now = Date.parse('2026-10-28T12:00:00Z');
        const plan = { finalSha: sha, mainSha: sha, inputsKey: 'fallback-cas', applied: [] };
        // Round-trip the saved fallback to reproduce adoption after a daemon restart.
        const ready = JSON.parse(JSON.stringify({ kind: 'fallback', prevHead: sha, adopt: plan,
          forInputsKey: plan.inputsKey, dropRefs: [suspect], failed: 'smoke', passedAt: new Date(now).toISOString() }));
        const match = recovery ? matchReadyCandidate({ ready, plan, prevHead: sha, nowMs: now,
          maxAgeMs: 60_000, stillWanted: () => true, verifyBuilt: () => true }) : { adopt: plan, dropRefs: [suspect] };
        if (!match.adopt) throw new Error('fixture fallback did not match');
        const result = await finalizeRebuild({ root, env, log: {}, now: () => now, prevHead: sha,
          lease: { token: 'suspect-cas' }, plan: match.adopt,
          run: (args) => {
            if (args[0] !== 'rev-parse') throw new Error(`unexpected Git command: ${args[0]}`);
            return { status: 0, stdout: `${sha}\n` };
          },
          onAdopted: ({ alert }) => dropSuspectOverlays({ root, env, suspects: match.dropRefs, failed: 'smoke', alert }),
        });
        const label = `${recovery ? 'recovered' : 'direct'} ${identity}`;
        const kept = readOverlays(root, { env });
        const kinds = result.alerts.map(a => a.kind);
        const audit = file.replace(/\.json$/, '.events.jsonl');
        if (!result.adopted || kinds.includes('on-adopted-failed')) violations.push(`${label}: adoption failed`);
        if (identity === 'matching') {
          if (kept.length || !kinds.includes('overlay-dropped-smoke-failed') || !existsSync(audit)) {
            violations.push(`${label}: proven suspect was not dropped and audited`);
          }
        } else if (readFileSync(file, 'utf8') !== before || kept[0]?.registrationId !== current.registrationId
          || !kinds.includes('overlay-registration-changed') || kinds.includes('overlay-dropped-smoke-failed') || existsSync(audit)) {
          violations.push(`${label}: unbound or replaced suspect was dropped or reported as dropped`);
        }
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  }
  return { violations };
}

export default {
  id: 'overlay-suspect-registration-cas',
  title: 'direct and recovered fallback adoption keep suspects without matching registration evidence',
  card: 'PR #6033',
  fixedBy: { sha: '78683188d5,4af2025951', where: 'lane/overlay-generation-s1-r2', paths: ['scripts/lib/daemon-rebuild/adopt.mjs', 'scripts/lib/daemon-overlays.mjs'] },
  fixPresent(root) {
    const script = 'const { default: b } = await import(process.argv[1]); process.exitCode = b.judge(await b.run()).length ? 1 : 0;';
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', script,
      pathToFileURL(join(root, 'scripts/conveyor/soak/breaks/overlay-suspect-registration-cas.mjs')).href], {
      env: { ...process.env, SOAK_TREE_ROOT: root }, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024,
    });
    return probe.status === 0;
  },
  run() { return replay(process.env.SOAK_TREE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')); },
  judge(report) { return report.violations; },
};
