/**
 * @file breaks/rebuild-adopt-only-lease.mjs — R830: a daemon's adopt-only tick left a build lease
 * naming its own live pid. A separate rebuild job honoured it as a running build and kept returning
 * rebuild-in-progress. An adopt-only lease must be reclaimable while a live real-job lease still blocks.
 *
 * Claim both leases through the real API in the live parent (the daemon), then have a separate Node
 * process (the rebuild job) inspect and claim them. Import the mechanism from this tree under test; keep
 * lease paths in a private temp root without booting the unrelated daemon simulator.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const JOB = `
  import { readFileSync } from 'node:fs';
  const { moduleUrl, root, env, nowMs, plan, leases } = JSON.parse(readFileSync(0, 'utf8'));
  const { buildLeaseIsLive, claimBuildLease, releaseBuildLease, ACTIVE_BUILD_TOKENS } = await import(moduleUrl);
  const results = leases.map((building) => {
    const state = { building };
    const live = buildLeaseIsLive(building, { env, nowMs });
    const claimed = claimBuildLease({ state, plan, root, env, nowMs });
    const result = { live, claimed, building: state.building };
    if (claimed) {
      releaseBuildLease(state, claimed);
      ACTIVE_BUILD_TOKENS.delete(claimed.token);
    }
    return result;
  });
  process.stdout.write(JSON.stringify({ pid: process.pid, results }));
`;

export default {
  id: 'rebuild-adopt-only-lease',
  title: 'a separate rebuild job reclaims the live daemon adopt-only lease while a live real-job lease still blocks',
  card: 'R830',
  fixedBy: {
    sha: '1667dcd23e',
    where: 'main',
    paths: ['scripts/lib/daemon-rebuild/lease.mjs'],
  },
  fixPresent(root) {
    try {
      const source = readFileSync(join(root, 'scripts/lib/daemon-rebuild/lease.mjs'), 'utf8');
      return /if \(building\.adoptOnly\) return false/.test(source)
        && /adoptOnly \? \{ adoptOnly: true \}/.test(source);
    } catch {
      return false;
    }
  },
  async run({ log } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'soak-rebuild-adopt-only-lease-'));
    const env = { ...process.env, WE_DAEMON_STATE_DIR: join(root, 'state') };
    const report = { fatal: null, violations: [] };
    const violation = (invariant, detail) => report.violations.push({ invariant, detail });
    try {
      const moduleUrl = new URL('../../../lib/daemon-rebuild/lease.mjs', import.meta.url).href;
      const { claimBuildLease, releaseBuildLease, ACTIVE_BUILD_TOKENS } = await import(moduleUrl);
      const nowMs = Date.now();
      const plan = { finalSha: 'a'.repeat(40), inputsKey: 'r830' };
      const adoptState = { building: null };
      const realState = { building: null };
      const options = { root, env, nowMs, plan };
      let adoptLease;
      let realLease;
      try {
        adoptLease = claimBuildLease({ ...options, state: adoptState, adoptOnly: true });
        realLease = claimBuildLease({ ...options, state: realState });
        if (!adoptLease || !realLease) throw new Error('R830: initial lease claims failed');
        if (adoptLease.pid !== process.pid || adoptLease.adoptOnly !== true || realLease.adoptOnly) {
          violation('lease-kind-not-recorded', 'the daemon claim did not preserve the adopt-only versus real-job distinction');
        }
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', JOB], {
          cwd: root,
          env,
          input: JSON.stringify({ ...options, moduleUrl, leases: [adoptLease, realLease] }),
          encoding: 'utf8',
          timeout: 30_000,
          maxBuffer: 64 * 1024,
        });
        if (child.error || child.status !== 0) {
          throw new Error(`R830: rebuild job probe failed: ${child.error?.message ?? child.stderr}`);
        }
        const { pid, results: [adopt, real] } = JSON.parse(child.stdout);
        if (!Number.isInteger(pid) || pid === process.pid) throw new Error('R830: job must run in another process');
        log?.(`r0 daemon pid=${process.pid}, job pid=${pid}: adopt-only live=${adopt.live}, real-job live=${real.live}`);
        if (adopt.live !== false || !adopt.claimed || adopt.claimed.pid !== pid
          || adopt.claimed.token === adoptLease.token || adopt.claimed.adoptOnly
          || adopt.building?.token !== adopt.claimed.token
          || adopt.claimed.target !== plan.finalSha || adopt.claimed.inputsKey !== plan.inputsKey) {
          violation('adopt-only-lease-blocked-job', 'the job failed to replace the live daemon adopt-only lease with its own real build lease');
        }
        if (real.live !== true || real.claimed !== null || JSON.stringify(real.building) !== JSON.stringify(realLease)) {
          violation('live-real-job-lease-reclaimed', 'the job must leave a live real-job lease unchanged and refuse its claim');
        }
      } finally {
        if (adoptLease) {
          releaseBuildLease(adoptState, adoptLease);
          ACTIVE_BUILD_TOKENS.delete(adoptLease.token);
        }
        if (realLease) {
          releaseBuildLease(realState, realLease);
          ACTIVE_BUILD_TOKENS.delete(realLease.token);
        }
      }
    } catch (error) {
      report.fatal = error.message;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    return report;
  },
  judge(report) {
    return [
      ...(report.fatal ? [`[crash] ${report.fatal}`] : []),
      ...report.violations.map((v) => `[${v.invariant}] ${v.detail}`),
    ];
  },
};
