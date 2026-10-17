/** Pure advisory outcome shared by review rendering and red-team scheduling. */
import { derivePanelVerdict, MANDATORY_LENSES, VERDICTS } from './jury-core.mjs';
import { ADVISORY_OUTCOMES } from './advisory-labels.mjs';
import { operatorSendBackVerdict } from './operator-send-backs.mjs';

/**
 * THE ADVISORY'S OWN OUTCOME — `accept` or `changes` — with the human gate FACTORED OUT. PURE.
 *
 * `verdict.verdict` cannot be used: `derivePanelVerdict` returns `needs-human` for EVERY gate-self PR before it
 * looks at a single finding, so it is identical for a clean advisory and a blocked one. This re-runs the SAME
 * reducer over the SAME admitted findings and lens verdicts with `humanRequired` off, i.e. "what would the panel
 * have said if this PR were not human-gated" — the honest answer to "did the advisory find anything blocking".
 * `accept` only when every mandatory lens accepts and no guard is owed; anything else is `changes`.
 *
 * `null` when no outcome can be honestly derived (no mandatory lens seated, a mandatory lens with no verdict) —
 * the caller then posts the note with no outcome line and applies no label, exactly like before this existed.
 *
 * @param {object} verdict the `reduce` step's output.
 * @returns {'accept'|'changes'|null}
 */
export function deriveAdvisoryOutcome(verdict) {
  const v = verdict && typeof verdict === 'object' ? verdict : {};
  if (v.blockedReferrals?.length) return ADVISORY_OUTCOMES.CHANGES;
  // Unruled mandatory referrals mean the panel is not done: no outcome (so no `advisory:*` label) rather than a
  // clean `accept`. Not `changes` either: nothing is broken, a ruling is owed, and `changes` would dispatch a fixer.
  if (v.pendingReferrals?.length) return null;
  const lensVerdicts = v.lensVerdicts && typeof v.lensVerdicts === 'object' ? v.lensVerdicts : {};
  const lenses = Array.isArray(v.lenses) && v.lenses.length ? v.lenses : Object.keys(lensVerdicts);
  try {
    const reduced = derivePanelVerdict({
      lensVerdicts,
      humanRequired: false,
      mandatoryLenses: MANDATORY_LENSES.filter((l) => lenses.includes(l)),
      // The ADMITTED set, exactly as `reduce` reduced it — an off-scope (unverifiable) citation must not block
      // here any more than it did there (#x6t2z6h). Falls back to the published list for a record that predates it.
      findings: v.admittedFindings ?? v.findings ?? [],
    });
    return reduced === VERDICTS.ACCEPT ? ADVISORY_OUTCOMES.ACCEPT : ADVISORY_OUTCOMES.CHANGES;
  } catch {
    return null;
  }
}

/**
 * THE OUTCOME THE NOTE STATES AND THE LABEL APPLIES — {@link deriveAdvisoryOutcome}, but only when the panel judged
 * a PINNED commit. An unpinned or degraded basis (`netBasis.rev` null) names no head, so there is no head for a
 * label to describe and no `Net basis: <base>..<head>` line a reader could compare against — the note then carries
 * no outcome line and no label is applied, rather than a label nothing can ever verify. PURE.
 * @returns {'accept'|'changes'|null}
 */
export function advisoryLabelOutcome({ read, verdict } = {}) {
  if (!read || read.degraded || !read.netBasis?.rev) return null;
  return operatorSendBackVerdict(deriveAdvisoryOutcome(verdict), read.openOperatorSendBacks);
}

