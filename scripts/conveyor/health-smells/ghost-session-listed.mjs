/**
 * @file scripts/conveyor/health-smells/ghost-session-listed.mjs
 * @description xegykal — a conveyor session `claude agents --json` still lists as working whose transcript is older
 *   than the ghost threshold and whose process is gone. Live 2026-10-04: prepare-2768, fix-2003, fix-2115 and
 *   fix-2267 (and several conveyor-* rows) read `working` 18-30 days after they ended — the reaper had already
 *   `claude stop`-ped them, but a pending in-flight cron wake kept the listing at `working`. The session watchdog
 *   clears each with `claude rm <id>` (session-reaper's `rmSessionRecord`) and re-lists to confirm. This smell
 *   breaches only for a ghost the watchdog could NOT clear (acting disabled, liveness unknown, `claude rm` failed,
 *   or `claude rm` reported success while the row stayed listed — Claude Code issue #77683, whose product path
 *   is the human-confirmed `clear-stuck-session` operation).
 */
export default {
  id: 'ghost-session-listed',
  scope: 'host',
  cadence: 'every-tick',
  probes: ['sessionWatchdog'],
  openAfter: 1,
  closeAfter: 1,
  severity: 'medium',
  action: 'alert',
  recommendationHint: 'A long-dead session is still listed as working and the watchdog could not clear it.',
  evaluate({ sessionWatchdog }) {
    const actions = sessionWatchdog?.actions || [];
    return (sessionWatchdog?.rows || []).filter((r) => r.class === 'ghost').map((r) => {
      const clear = actions.find((a) => a.type === 'clear-ghost' && a.session === r.name);
      const cleared = clear?.ok === true;
      return {
        subject: `session:${r.name}`,
        breach: !cleared,
        measure: { id: r.id, idleMinutes: r.evidence?.idleMinutes ?? null, pidAlive: r.pidAlive, clear: clear ? { ok: clear.ok, detail: clear.detail } : null },
        summary: cleared
          ? `${r.name} was a ghost (listed ${r.state}, transcript ${Math.round((r.evidence?.idleMinutes ?? 0) / 1440)}d old); cleared with claude rm.`
          : `${r.name} is listed ${r.state} but its transcript is ${Math.round((r.evidence?.idleMinutes ?? 0) / 1440)}d old and no process is alive; not cleared (${clear?.detail ?? 'no action planned'}).`,
        recommendation: clear?.ineffective
          ? `\`claude rm\` cannot remove ${r.name} (Claude Code issue #77683). Clear it with the human-confirmed operation: \`node scripts/operations/run.mjs clear-stuck-session --session=${r.id}\`.`
          : `Run \`node scripts/conveyor/session-watchdog.mjs --apply\` and read why the clear failed; never \`claude stop\`/\`rm\` it by hand without that reason.`,
        escalation: cleared ? undefined : {
          humanOnly: true, actionRef: `session:${r.name}`, description: `Ghost session ${r.name} could not be cleared`,
          status: 'observed', reason: clear?.detail ?? 'no clear action planned',
        },
      };
    });
  },
};
