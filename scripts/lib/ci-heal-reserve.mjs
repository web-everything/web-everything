/**
 * @file scripts/lib/ci-heal-reserve.mjs
 * @description A reserved ci-heal slot PAST the fixer cap. A PR that failed its OWN required check is owed a ci-heal
 *   owner; review fixes that fill the cap must not starve it (live incident 2026-10-07: #4235 sat red for hours, the
 *   daemon logging `refused fix-cap ... ci-heal deferred` every pass). Used by `ci-heal-pr-dispatch.mjs` only when the
 *   shared throttle refused with `fix-cap`. Host load still refuses (a hot machine is not a cap). Defer-only, never
 *   interrupts running work. Env WE_CI_HEAL_RESERVE (default 1, 0 = off).
 */
import os from 'node:os';
import { hostLoadGate, resolveMaxLoadPerCore } from './dispatch-throttle.mjs';

export function resolveCiHealReserve({ env = process.env } = {}) {
  const e = env?.WE_CI_HEAL_RESERVE;
  const n = Number(e);
  return e !== undefined && e !== '' && Number.isInteger(n) && n >= 0 ? n : 1;
}

/** ONE per pass. `tryAdmit()` -> `{admit:true, reserved:true}` | `{admit:false, kind, why}`. */
export function createCiHealReserve({
  listClaims = () => [], env = process.env, loadavg = () => os.loadavg()[0], cpuCount = () => os.cpus().length,
} = {}) {
  let liveHeal = null;
  return {
    tryAdmit() {
      const reserve = resolveCiHealReserve({ env });
      if (liveHeal === null) { try { liveHeal = listClaims().filter((c) => c?.meta?.kind === 'ci-heal').length; } catch { liveHeal = 0; } }
      if (liveHeal >= reserve) {
        return { admit: false, kind: 'fix-cap', why: `fixer cap full and the ${reserve} reserved ci-heal slot(s) (WE_CI_HEAL_RESERVE) are in use (${liveHeal} live ci-heal)` };
      }
      let gate = { admit: true };
      try { gate = hostLoadGate({ load: loadavg(), cores: cpuCount(), maxLoadPerCore: resolveMaxLoadPerCore({ env }) }); } catch { /* fail open */ }
      if (!gate.admit) return gate;
      liveHeal += 1;
      return { admit: true, reserved: true };
    },
  };
}
