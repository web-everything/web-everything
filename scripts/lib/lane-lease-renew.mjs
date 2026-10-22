/**
 * @file scripts/lib/lane-lease-renew.mjs
 * @description The IO half of "lease liveness follows the occupant" (lane-lease-occupant, 2026-10-22). The pure rule
 *   is `leaseRenewalOnUse` in we:scripts/lib/lane-lease.mjs; this module reads the setting through the policy cascade
 *   and writes the renewed lease back. Called by the PreToolUse guards (`guard-bash.mjs`, `guard-lane.mjs`) after
 *   they ALLOW a call in a lane, so the agent actually using a lane keeps its lease alive with no extra command — the
 *   lease no longer lapses because the short-lived shell that ran `lane-pool.mjs acquire` exited long ago.
 *
 *   Setting `laneLease.renewOnUseMinutes` (default 5, range 1–60): standard → platform preference `laneLease` →
 *   `we:scripts/settings/lane-lease.json` → env `WE_LANE_LEASE_RENEW_MINUTES`. Each source is logged by the cascade
 *   (`WE_POLICY_CASCADE_LOG=1` in a hook) and the renewal records `renewedBy` on the lease itself. There is no switch
 *   that turns the destructive-op proof off; this setting only spaces the heartbeat writes.
 *
 *   Never throws: a renewal fault must never wedge the guard that called it.
 */
import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  LEASE_FILENAME, BUILT_IN_LANE_LEASE_SETTINGS, LANE_LEASE_SETTING_RULES, LANE_LEASE_SETTING_ENV, leaseRenewalOnUse,
} from './lane-lease.mjs';
import { cascadePolicy } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';

/** The resolved lease settings + their sources. Never throws. */
export function readLaneLeaseSettings({ env = process.env, read = readSettings, platform, log } = {}) {
  let tool;
  try { tool = read()?.laneLease; } catch { tool = undefined; }
  const envValues = {};
  for (const [key, name] of Object.entries(LANE_LEASE_SETTING_ENV)) {
    const raw = env?.[name];
    if (raw !== undefined && raw !== '') envValues[key] = Number(raw);
  }
  try {
    const r = cascadePolicy('laneLease', tool, {
      standard: { ...BUILT_IN_LANE_LEASE_SETTINGS }, envValues, valid: LANE_LEASE_SETTING_RULES,
      ...(platform !== undefined ? { platform } : {}), env, ...(log ? { log } : {}),
    });
    const value = { ...BUILT_IN_LANE_LEASE_SETTINGS, ...(r.value || {}) };
    if (!LANE_LEASE_SETTING_RULES.renewOnUseMinutes(value.renewOnUseMinutes)) value.renewOnUseMinutes = BUILT_IN_LANE_LEASE_SETTINGS.renewOnUseMinutes;
    return { value, sources: r.sources, invalid: r.invalid };
  } catch {
    return { value: { ...BUILT_IN_LANE_LEASE_SETTINGS }, sources: { renewOnUseMinutes: 'standard' }, invalid: [] };
  }
}

const readJson = (file) => {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
};

/**
 * Renew `laneRoot`'s lease when its occupant is the caller and the throttle window has passed. Returns the renewed
 * lease, or null. The write is a temp-file rename; right before the rename the marker is re-read and the renewal is
 * dropped unless it is still the SAME hold (same `acquiredAt` + `holder`) — a lease released or taken over meanwhile
 * is never overwritten or revived. (Residual: the microseconds between that re-read and the rename.)
 * @param {{laneRoot:string, mySessionId?:string|null, assertedSlug?:string|null, nowMs?:number, settings?:object}} p
 */
export function renewLeaseOnUse({ laneRoot, mySessionId = null, assertedSlug = null, nowMs = Date.now(), settings } = {}) {
  try {
    if (!laneRoot) return null;
    const file = join(laneRoot, '.git', LEASE_FILENAME);
    const lease = readJson(file);
    // Cheap pre-check at the smallest legal window, so the settings files are read only when a renewal may be due.
    if (!leaseRenewalOnUse({ lease, mySessionId, assertedSlug, nowMs, throttleMs: 60_000 })) return null;
    const minutes = (settings ?? readLaneLeaseSettings().value).renewOnUseMinutes;
    const renewed = leaseRenewalOnUse({ lease, mySessionId, assertedSlug, nowMs, throttleMs: minutes * 60_000 });
    if (!renewed) return null;
    const tmp = `${file}.renew-${process.pid}-${randomBytes(4).toString('hex')}`;
    writeFileSync(tmp, JSON.stringify(renewed, null, 2) + '\n', { flag: 'wx' });
    try {
      const now = readJson(file);
      if (!now || now.acquiredAt !== lease.acquiredAt || now.holder !== lease.holder || now.session !== lease.session
        || (now.workerSession ?? null) !== (lease.workerSession ?? null) || (now.renewedAt ?? null) !== (lease.renewedAt ?? null)) return null;
      renameSync(tmp, file);
      return renewed;
    } finally {
      rmSync(tmp, { force: true });
    }
  } catch {
    return null;
  }
}
