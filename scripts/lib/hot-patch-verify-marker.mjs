import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { urgentLedger, urgentKeyPath, urgentSignature } from '../operations/urgent-verify-marker.mjs';

/** Read authenticated full-verify evidence; red is valid evidence requiring rollback. */
export function readHotPatchVerifyMarker({ sha, env }) {
  const refused = { ok: false, reason: 'verify-marker-unavailable; run urgent-verify for this exact sha and retry verify-result' };
  if (!/^[a-f0-9]{40}$/.test(sha ?? '') || !env.HOME) return refused;
  try {
    const records = readFileSync(urgentLedger(env.HOME), 'utf8').split(/\r?\n/)
      .filter(line => line.trim()).map(line => JSON.parse(line));
    const marker = records.filter(record => record?.sha === sha).at(-1);
    if (!marker || marker.suite !== 'full' || !Number.isInteger(marker.shards) || marker.shards < 1
      || !['red', 'green'].includes(marker.result)
      || typeof marker.host !== 'string' || !marker.host.trim()
      || typeof marker.finishedAt !== 'string' || !Number.isFinite(Date.parse(marker.finishedAt))
      || typeof marker.startedAt !== 'string' || !(Date.parse(marker.startedAt) < Date.parse(marker.finishedAt))
      || typeof marker.sig !== 'string' || !/^[a-f0-9]{64}$/.test(marker.sig)
      || !timingSafeEqual(Buffer.from(marker.sig, 'hex'),
        Buffer.from(urgentSignature(marker, readFileSync(urgentKeyPath(env.HOME))), 'hex'))) return refused;
    return { ok: true, marker };
  } catch { return refused; }
}
