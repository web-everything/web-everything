/** Shared re-entrant admission marker normalization, also used by the shell guards. */
export const ADMISSION_HELD_ENV = 'WE_HEAVY_ADMISSION_HELD';
export function isAdmissionHeld(env = process.env) {
  return /^(?:1|true|yes|on)$/i.test(String(env?.[ADMISSION_HELD_ENV] ?? '').trim());
}
