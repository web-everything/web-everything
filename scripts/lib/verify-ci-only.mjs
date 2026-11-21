/** R1086: opening on CI alone requires observed host saturation; never a local green. */
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { collectHostCapacity } from '../readiness/host-capacity.mjs';
import { hostLoadAdmission } from './host-load.mjs';
import { greenLedgerWritable } from './lane-verify.mjs';
import { DEFERRED_OPEN_MODES, oneLine } from './lane-verify-deferred.mjs';

/** IO with injectable sources. Unknown readings and memory-only refusals cannot authorize ci-only. */
export function hostSaturation({ collect = collectHostCapacity, admission = hostLoadAdmission } = {}) {
  let reading;
  try { reading = collect({ includeQueue: false, includeForge: false }); } catch { /* unknown */ }
  const idle = reading?.mac?.idlePct;
  const threshold = reading?.thresholds?.cpuIdleLowPct;
  const validIdle = Number.isFinite(idle) && idle >= 0 && idle <= 100;
  const detail = `CPU idle ${validIdle ? idle : 'unknown'}%`;
  // collectHostCapacity resolves this threshold through the capacity gate's policy cascade (default 15).
  if (validIdle && Number.isFinite(threshold) && threshold >= 0 && threshold <= 100 && idle < threshold) {
    const source = reading.sources?.['host.capacity.cpuIdleLowPct'] ?? 'standard';
    return { saturated: true, reason: `${detail} < host.capacity.cpuIdleLowPct=${threshold}% (${source})` };
  }
  try {
    const verdict = admission({ interactive: false, capacity: () => reading });
    if (verdict?.admitted === false && /^host load \d/.test(verdict.reason)) {
      return { saturated: true, reason: `${detail}; ${oneLine(verdict.reason)}` };
    }
  } catch { /* unknown admission is not evidence of saturation */ }
  return { saturated: false, reason: `${detail}; no measured CPU or host-load saturation; retry local verification or inspect host probes` };
}

/** Pure apart from the injected saturation reader; omitted verify preserves the existing finish guard. */
export function ciOnlyDecision({ verify, mode, saturation = hostSaturation } = {}) {
  if (verify === undefined) return null;
  if (verify !== 'ci-only') return { ok: false, reason: 'bad-verify', detail: '--verify accepts only ci-only' };
  if (!DEFERRED_OPEN_MODES.includes(mode)) return { ok: false, reason: 'bad-verify', detail: '--verify=ci-only requires park, label-on-green, or open-only; land is forbidden' };
  let host;
  try { host = saturation(); } catch { /* unreadable evidence refuses */ }
  if (host?.saturated !== true) return { ok: false, reason: 'ci-only-not-saturated', detail: oneLine(host?.reason || 'CPU idle unknown; host saturation unreadable; retry local verification or inspect host probes') };
  const reason = oneLine(host.reason);
  return { ok: true, reason: 'ci-only', hostReason: reason, disclosure: `verify: ci-only (host saturated: ${reason})` };
}

/** Best-effort separate audit ledger. No status:green and never stored in verify-green. */
export function recordCiOnly({ repo, coordinationRoot, sha, reason, env = process.env, recordedAt = new Date().toISOString() }) {
  const override = env.WE_VERIFY_CI_ONLY_LEDGER_DIR?.trim();
  if (!greenLedgerWritable({ repo, env: { WE_VERIFY_GREEN_LEDGER_DIR: override } }) || !/^[0-9a-f]{40}$/.test(String(sha))) return false;
  try {
    const dir = override || join(coordinationRoot, 'verify-ci-only');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${sha}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sha, mode: 'ci-only', reason: oneLine(reason), recordedAt }) + '\n');
    renameSync(tmp, file);
    return true;
  } catch { return false; }
}
