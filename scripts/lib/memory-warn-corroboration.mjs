/** Pure memory-pressure corroboration and floor decisions; no IO or runtime imports. */
export const DEFAULT_WARN_MIN_FREE_PCT = 20;
export const DEFAULT_WARN_SWAP_GROWTH_MB = 256;

/** Pure pressure check. Only level 2 can relax, and readable, clean free memory is mandatory. */
export function decideMemoryPressure({ pressureLevel, minPressureLevel = 2, freePct, swapGrowthMb,
  warnMinFreePct = DEFAULT_WARN_MIN_FREE_PCT, warnSwapGrowthMb = DEFAULT_WARN_SWAP_GROWTH_MB } = {}) {
  freePct = Number.isFinite(freePct) && freePct >= 0 && freePct <= 100 ? freePct : null;
  swapGrowthMb = Number.isFinite(swapGrowthMb) ? swapGrowthMb : null;
  const inputs = { freePct, swapGrowthMb, warnMinFreePct, warnSwapGrowthMb };
  const scarce = (freePct !== null && freePct < warnMinFreePct)
    || (swapGrowthMb !== null && swapGrowthMb > warnSwapGrowthMb);
  const unknown = freePct === null;
  const critical = Number.isFinite(pressureLevel) && pressureLevel >= 4;
  const nonWarn = Number.isFinite(pressureLevel) && pressureLevel > 1 && pressureLevel !== 2;
  const held = nonWarn || (Number.isFinite(pressureLevel) && pressureLevel >= minPressureLevel && (scarce || unknown));
  const evidence = `free ${freePct ?? '?'}% (${freePct === null ? '?' : freePct < warnMinFreePct ? '<' : '>='}${warnMinFreePct}%), swap ${swapGrowthMb === null ? '?' : swapGrowthMb >= 0 ? `+${swapGrowthMb}` : swapGrowthMb}MB (${swapGrowthMb === null ? '?' : swapGrowthMb > warnSwapGrowthMb ? '>' : '<='}${warnSwapGrowthMb}MB)`;
  return { held, ...inputs, reason: `mem pressure ${pressureLevel} (>=${minPressureLevel}) ${critical ? 'critical' : nonWarn ? 'non-warn pressure' : unknown ? 'warn corroboration unavailable' : scarce ? 'corroborated' : 'uncorroborated'}: ${evidence}` };
}
/** macOS kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical. */
const PRESSURE_NAME = { 1: 'normal', 2: 'warn', 3: 'warn', 4: 'critical' };

/**
 * PURE hard memory floor for admitting a new fixer. Fail closed: any unreadable input refuses.
 * Refuses below the floor, under corroborated warn/critical, or when the available reading, the pressure level or the
 * floor itself is missing, non-numeric or an unknown level. `snapshotFresh:false` is an unreadable reading too.
 * @returns {{admit:boolean, reason:string}}
 */
export function decideMemoryFloor({ availableMb, floorMb, pressureLevel, snapshotFresh = true, ...pressureInputs } = {}) {
  const n = (v) => typeof v === 'number' && Number.isFinite(v);
  if (!snapshotFresh) return { admit: false, reason: 'memory reading unavailable (no fresh snapshot)' };
  if (!n(floorMb) || floorMb <= 0) return { admit: false, reason: 'memory floor unreadable' };
  if (!n(availableMb) || availableMb < 0) return { admit: false, reason: 'available memory unreadable' };
  if (!n(pressureLevel) || !PRESSURE_NAME[pressureLevel]) return { admit: false, reason: 'memory pressure unreadable' };
  const pressure = decideMemoryPressure({ ...pressureInputs, pressureLevel });
  if (pressure.held) return { admit: false, reason: pressure.reason };
  if (availableMb < floorMb) return { admit: false, reason: `available ${availableMb} MB < floor ${floorMb} MB` };
  return { admit: true, reason: `available ${availableMb} MB >= floor ${floorMb} MB, pressure ${PRESSURE_NAME[pressureLevel]}` };
}
