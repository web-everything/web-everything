/** Pre-launch availability only; never retry a provider after a session may have started. */
import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { readStore } from '../conveyor/run-scorecard-store.mjs';
import { providerQuotaHold } from './provider-quota-hold.mjs';
export function dispatchProviderAvailable(provider, { env = process.env, records, now = Date.now(), access = accessSync } = {}) {
  if (records === undefined) {
    try { records = readStore({ strict: true }).records; } catch { return false; }
  }
  const family = provider.startsWith('agy-') ? 'antigravity' : provider;
  if (providerQuotaHold(records, family, now)) return false;
  const binary = family === 'antigravity' ? 'agy' : family;
  return String(env.PATH ?? '').split(':').some(dir => {
    try { access(join(dir, binary), constants.X_OK); return true; } catch { return false; }
  });
}
