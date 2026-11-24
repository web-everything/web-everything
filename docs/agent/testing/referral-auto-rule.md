## Referral auto ruler

The review hold reconciliation runs a capacity-gated ruler independently of judge sweeps.
R903 maps confirmed introduced correctness/security bugs to block, pre-existing or adjacent gaps,
test gaps and hardening to card, and uncertainty to operator escalation. Cards require a readable
backlog reference. Missing evidence leaves the referral pending. The delegate actor `referral-ruler`
is automation-authored (R1035), never an operator; it may only card or block pending findings,
cannot supersede a ruling, and cannot clear human review. The writer requires the expected head.
The sweep re-reads eligibility before every write; stale heads, disputes, judgment calls and human
clearances remain untouched. The older auto-block pass must not consume escalated referrals.
`WE_REFERRAL_AUTO_RULE=0` disables this path. Settings use the shared policy cascade.
Hermetic unit and soak tests inject capacity, model output and the sanctioned ruling CLI seam.
