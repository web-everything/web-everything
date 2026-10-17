/** Atomic per-session admission shared by lanes beside the shadow agreement store.
 * Reservations count starts (including failures/retries), so crashed sessions cannot
 * overspend the cap. No read/modify/write race or lock requiring stale recovery.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolveShadowAgreementPath } from './review-shadow-agreement.mjs';

export function shadowBudgetDay(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}

export function reserveShadowSession({ dailyCap, now = Date.now(), path = resolveShadowAgreementPath() }) {
  if (!Number.isSafeInteger(dailyCap) || dailyCap < 0) return { allowed: false, reason: 'invalid daily cap' };
  try {
    const dir = `${path}.sessions/${shadowBudgetDay(now)}`;
    mkdirSync(dir, { recursive: true });
    for (let slot = 0; slot < dailyCap; slot++) {
      try {
        writeFileSync(`${dir}/${slot}`, `${new Date(now).toISOString()}\n`, { flag: 'wx' });
        return { allowed: true };
      } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    return { allowed: false, reason: 'daily cap reached' };
  } catch { return { allowed: false, reason: 'daily cap store unavailable' }; }
}
