/** Atomic per-session admission shared by lanes beside the shadow agreement store.
 * Reservations count starts (including failures/retries), so crashed sessions cannot
 * overspend the cap. No read/modify/write race or lock requiring stale recovery.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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
        const token = randomUUID();
        writeFileSync(`${dir}/${slot}`, `${new Date(now).toISOString()} ${token}\n`, { flag: 'wx' });
        return { allowed: true, slot, day: shadowBudgetDay(now), token, dailyCap };
      } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    return { allowed: false, reason: 'daily cap reached' };
  } catch { return { allowed: false, reason: 'daily cap store unavailable' }; }
}

/** Free one reserved slot (a known-bad read_file void must not burn the day's cap). Safe to replay: only the
 * reservation that owns the slot (matching token) can free it, and at most dailyCap refunds are granted per day, so a
 * refund loop still ends. Returns false when nothing was freed. */
export function releaseShadowSession({ slot, day, token, dailyCap, now = Date.now(), path = resolveShadowAgreementPath() } = {}) {
  if (!Number.isSafeInteger(slot) || slot < 0 || typeof token !== 'string' || !token || !Number.isSafeInteger(dailyCap) || dailyCap < 1) return false;
  try {
    const dir = `${path}.sessions/${day ?? shadowBudgetDay(now)}`;
    const file = `${dir}/${slot}`;
    if (!readFileSync(file, 'utf8').includes(token)) return false;
    mkdirSync(`${dir}/refunds`, { recursive: true });
    let granted = false;
    for (let n = 0; n < dailyCap && !granted; n++) {
      try { writeFileSync(`${dir}/refunds/${n}`, token, { flag: 'wx' }); granted = true; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    if (!granted) return false;
    unlinkSync(file);
    return true;
  } catch { return false; }
}
