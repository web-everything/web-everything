/**
 * ruling-needed-waiting — a PR whose review parked with confirmed findings that need the operator's
 * block/card/not-real ruling, and that has waited more than `rulingNeededAfterMs` (config dimension, default 2 h)
 * on the same head. Live 2026-10-04: PR #3794 waited about 8 h with nothing telling the operator (#3771 and #3833
 * showed the same shape). The park itself is correct; the silence was the defect, so this is the backstop for the
 * NEEDS-YOU row, label and push: if those all failed, a long wait still raises an alert here.
 *
 * Reads the same durable fact as the row/label (`we:scripts/lib/ruling-ledger.mjs#rulingNeeded`), so a ruling or
 * a new head closes the episode on the next read. Alert-only: the ruling is a human judgment.
 */
import { HOUR, fmtAge } from '../health-watch-core.mjs';
import { rulingNeeded } from '../../lib/ruling-ledger.mjs';

export default {
  id: 'ruling-needed-waiting',
  scope: 'repo',
  cadence: 'gh',
  probes: ['prs'],
  openAfter: 1,
  closeAfter: 1,
  severity: 'high',
  action: 'alert',
  /** Fallback only: the live value is `config.rulingNeededAfterMs` (`<stateRoot>/.conveyor/health/config.json`). */
  waitMs: 2 * HOUR,
  recommendationHint: 'A parked review has confirmed findings waiting on your block/card/not-real ruling.',
  evaluate({ prs }, { now, config }) {
    const waitMs = Number.isFinite(config?.rulingNeededAfterMs) ? config.rulingNeededAfterMs : this.waitMs;
    const out = [];
    for (const pr of prs || []) {
      const need = rulingNeeded(pr);
      if (!need) continue;
      const waited = need.since === null ? 0 : Math.max(0, now - need.since);
      const lines = need.findings.map((f) => `${f.file ?? '(no file)'}${f.line ? `:${f.line}` : ''} — ${f.summary}`);
      out.push({
        subject: `${pr.repo}#${pr.number}`,
        breach: need.since !== null && waited >= waitMs,
        measure: { waitedMin: Math.round(waited / 60_000), afterMin: Math.round(waitMs / 60_000), findings: need.findings.length, head: need.head.slice(0, 9) },
        summary: `${pr.repo}#${pr.number} has waited ${fmtAge(waited)} for a ruling on ${need.findings.length} confirmed finding(s): ${lines.join('; ')}.`,
        recommendation: `Rule on each finding of ${pr.repo}#${pr.number} (block, card or not-real) — see the RULING NEEDED section of `
          + '`node scripts/operations/operator-queue.mjs`. A new push or a recorded ruling clears this.',
      });
    }
    return out;
  },
};
