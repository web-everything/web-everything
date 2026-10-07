/**
 * @file scripts/conveyor/health-smells/builder-starved.mjs
 * @description builder-starved (2026-10-07) — the build-dispatch daemon has a queue and free capacity, yet has
 *   launched NOTHING (no build, no item prepare) for longer than `WE_BUILDER_STARVED_MINUTES` (default 60).
 *   Live: from 03:45Z to 10:51Z 2026-10-07 the builder ticked every ~2 minutes with ~400 queued and both prepare
 *   slots free, and `prepare.planned/launched` stayed empty, because phantom prepare-scope spawns spent the
 *   queue-time budget and failure-held cards filled the prepare-ahead window. Every tick looked like a correct
 *   no-op, so `daemon-owed-no-dispatch` never fired. Reads the builder memory the core folds from the daemon's own
 *   JSON tick records (`builderLog` probe). Shadow-safe: it only reports.
 */
import { MINUTE, fmtAge } from '../health-watch-core.mjs';
import { builderStarvedMinutes } from '../health-builder-ticks.mjs';

/** Pure: the breach decision for one builder memory. Exported for the test. */
export function builderStarvedVerdict(builder, { now, limitMinutes }) {
  if (!builder || !Number.isFinite(builder.lastTickAt)) return null;
  const since = Number.isFinite(builder.lastLaunchAt) ? builder.lastLaunchAt : builder.firstSeenAt;
  const idleMs = Math.max(0, now - since);
  const queued = Number(builder.queued) || 0;
  // A builder that stopped ticking is `daemon-silent`'s case, not this one: only judge a fresh last tick.
  const fresh = now - builder.lastTickAt <= Math.max(15 * MINUTE, limitMinutes * MINUTE);
  const breach = fresh && queued > 0 && builder.capacityFree === true && builder.frozen !== true && idleMs >= limitMinutes * MINUTE;
  return { breach, idleMs, queued, since, knownSince: Number.isFinite(builder.lastLaunchAt) };
}

export default {
  id: 'builder-starved',
  scope: 'host',
  cadence: 'every-tick',
  probes: ['builderLog'],
  openAfter: 1,
  closeAfter: 2,
  severity: 'high',
  action: 'investigate',
  recommendationHint: 'The builder has queued work and free slots but launches nothing. Read its latest tick record: prepare.planned, buildHolds and the tick core notes name what holds it.',
  evaluate(_probes, { now, builder, env = process.env }) {
    const limitMinutes = builderStarvedMinutes(env);
    const v = builderStarvedVerdict(builder, { now, limitMinutes });
    if (!v) return [];
    const idle = fmtAge(v.idleMs);
    return [{
      subject: 'build-dispatch-daemon',
      breach: v.breach,
      measure: { idleMinutes: Math.round(v.idleMs / MINUTE), limitMinutes, queued: v.queued, capacityFree: builder.capacityFree === true,
        lastLaunchAt: v.knownSince ? new Date(builder.lastLaunchAt).toISOString() : null, lastLaunch: builder.lastLaunch ?? null },
      summary: `build-dispatch-daemon: ${v.queued} queued and free capacity, but no build or prepare launched for ${idle}${v.knownSince ? '' : ' (no launch seen since the watch started reading)'} (limit ${limitMinutes}m).`,
      recommendation: 'Run `node skills-src/conveyor/build-dispatch-daemon.mjs --dry-run --json` in a lane: if prepare.planned is empty, read the tick core notes (queue-cap, prepare-ahead-window, prepare-no-lane) and buildHolds, and fix the gate that holds every card.',
    }];
  },
};
