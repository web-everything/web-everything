/**
 * The nightly ledger-readiness check (we:scripts/lib/ledger-readiness-daily.mjs) found the verdict ledger less safe
 * or less in agreement with the drain than before: unsafe disagreements (the ledger would clear a PR the drain holds)
 * exceed `verdictLedger.promotion.maxUnsafeDisagreements`, or agreement dropped versus the previous day's line.
 * Reads only the latest history line, so the episode holds for the day and moves when the next nightly line lands.
 * Read-only: nothing here changes mergeGate.reviewAuthority.
 */
export default {
  id: 'ledger-readiness-regressed',
  scope: 'host',
  cadence: 'every-tick',
  probes: ['ledgerReadiness'],
  openAfter: 1,
  closeAfter: 1,
  severity: 'medium',
  action: 'alert',
  recommendationHint: 'The verdict ledger disagrees with the drain more, or unsafely — read the latest ledger-readiness history line.',
  evaluate({ ledgerReadiness }) {
    const l = ledgerReadiness?.latest;
    if (!l || typeof l !== 'object') return [];
    const unsafe = l.unsafeOverLimit === true;
    const dropped = l.agreementDropped === true;
    const parts = [];
    if (unsafe) parts.push(`${l.unsafe} unsafe disagreement(s) (ledger clears, drain holds) over the limit of ${l.maxUnsafeDisagreements}`);
    if (dropped) parts.push(`agreement fell to ${l.agreementPct}% from ${l.previousAgreementPct}%`);
    return [{
      subject: 'verdict-ledger',
      breach: unsafe || dropped,
      measure: { day: l.day, agreementPct: l.agreementPct, previousAgreementPct: l.previousAgreementPct ?? null, unsafe: l.unsafe, maxUnsafeDisagreements: l.maxUnsafeDisagreements, ready: !!l.ready },
      summary: parts.length ? `ledger readiness ${l.day}: ${parts.join('; ')}.` : `ledger readiness ${l.day}: agreement ${l.agreementPct}%, unsafe ${l.unsafe}.`,
      recommendation: unsafe
        ? 'Run `node scripts/ledger-readiness.mjs --replay` and read the rows where the ledger clears and the drain holds: each is a hold the ledger cannot yet express. Do not promote the ledger until it is zero.'
        : 'Run `node scripts/ledger-readiness.mjs --replay`; its top disagreement reasons name what new strictness appeared since yesterday.',
    }];
  },
};
