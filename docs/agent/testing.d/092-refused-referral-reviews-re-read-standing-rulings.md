## Refused referral reviews re-read standing rulings

A `stageVerdict` refusal has consumed its confirm and has no `pending` step. Preserve that
shape in `reviewRunEvidence`; live thread evidence must stay outside its durable projection cache.
Before releasing or rewinding this refusal, re-derive `mandatoryReferralState` through
`liveReferralState`, requiring every saved pending finding key in the same run/head record.
Reason tokens such as `author-stamp-missing` (`PENDING_REASON_TOKENS`, the one set `attempted`,
`count` and this check share) name no finding: the empty
live pending list answers them, so an unstamped PR body still resumes once every finding is ruled. Missing
records, partial rulings, malformed comments, unreadable cards and subject mismatches keep it
blocked. A comment timestamp alone cannot prove a ruling stands. Reuse `mandatoryReferrals`
rewind so the sink, reducer and acceptance gates still decide the resulting verdict.
`review-ruling-resume.test.mjs` covers explicit and automatic resumes without new jurors,
and the closed paths; run it and the referral-hold suites through heavy-admission.


