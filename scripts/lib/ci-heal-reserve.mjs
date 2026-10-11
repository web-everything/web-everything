/**
 * @file scripts/lib/ci-heal-reserve.mjs
 * @description A reserved ci-heal slot PAST the fixer cap. A PR that failed its OWN required check is owed a ci-heal
 *   owner; review fixes that fill the cap must not starve it (live incident 2026-10-07: #4235 sat red for hours, the
 *   daemon logging `refused fix-cap ... ci-heal deferred` every pass). Used by `ci-heal-pr-dispatch.mjs` only when the
 *   shared throttle refused with `fix-cap`. Host load still refuses (a hot machine is not a cap). Defer-only, never
 *   interrupts running work. Env WE_CI_HEAL_RESERVE (default 2, 0 = off). Two, not one: live 2026-10-07 the single slot sat on #4283's heal
 *   (push-rejected, going nowhere) and starved #4235's for an hour.
 */
import os from 'node:os';
import { gateLaunch } from './resource-gate.mjs';

export function resolveCiHealReserve({ env = process.env } = {}) {
  const e = env?.WE_CI_HEAL_RESERVE;
  const n = Number(e);
  return e !== undefined && e !== '' && Number.isInteger(n) && n >= 0 ? n : 2;
}

/** ONE per pass. `tryAdmit()` -> `{admit:true, reserved:true}` | `{admit:false, kind, why}`. */
export function createCiHealReserve({
  listClaims = () => [], env = process.env, loadavg = () => os.loadavg()[0], cpuCount = () => os.cpus().length, sample,
  // x6nuodj: the host gate decides through admit({kind:'ci-heal'}) (legacy gateHost is the logged comparison).
  gate = () => gateLaunch({ kind: 'ci-heal', gate: 'ci-heal-reserve', env, loadavg, cpuCount, ...(sample ? { sample } : {}) }),
} = {}) {
  let liveHeal = null;
  let holders = [];
  return {
    tryAdmit() {
      const reserve = resolveCiHealReserve({ env });
      if (liveHeal === null) {
        try { holders = listClaims().filter((c) => c?.meta?.kind === 'ci-heal').map((c) => `#${c.meta.pr}`); } catch { holders = []; }
        liveHeal = holders.length;
      }
      if (liveHeal >= reserve) {
        const who = holders.length ? ` — held by ci-heal ${holders.join(', ')}; this PR is next in line` : '';
        return { admit: false, kind: 'fix-cap', why: `fixer cap full and the ${reserve} reserved ci-heal slot(s) (WE_CI_HEAL_RESERVE) are in use (${liveHeal} live ci-heal)${who}` };
      }
      let g = { admit: true };
      try { g = gate(); } catch { /* fail open */ }
      if (!g.admit) return g;
      liveHeal += 1;
      return { admit: true, reserved: true };
    },
  };
}
