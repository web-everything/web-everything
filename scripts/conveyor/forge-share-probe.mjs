/** R497 — health-watch's `forgeShare` probe: the settings-driven share read against the real heavy-admission lock root.
 *  Kept apart from `lib/forge-share.mjs` so that module never imports heavy-admission (which will call its recorder). Never throws. */
import { probeForgeShare } from '../lib/forge-share.mjs';
import { admissionLockRoot } from '../readiness/heavy-admission.mjs';

export function probeForgeShareForWatch({ repoRoot, env = process.env, now = Date.now() } = {}) {
  try { return probeForgeShare({ lockRoot: admissionLockRoot(repoRoot, env), now }); } catch (e) {
    const u = { status: 'unknown', share: null, belowTarget: null, secondsShare: null, unknownReason: 'probe-failed', detail: String(e?.message ?? e).slice(0, 200) };
    return { current: u, earlier: u };
  }
}
