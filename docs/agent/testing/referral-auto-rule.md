## Referral auto ruler

The review hold reconciliation runs a capacity-gated ruler independently of judge sweeps.
R903 maps confirmed introduced correctness/security bugs to block, pre-existing or adjacent gaps,
test gaps and hardening to card, and uncertainty to operator escalation. Cards require a readable
backlog reference matched by the shared card-dedupe helper (target file, guard class and claim); unreadable, oversized (over 128 KiB),
remote-only or unrelated card bodies escalate to the operator. Card evidence needs at least 60
characters, a non-trivial quoted code snippet, and an explicit statement that it predates the PR.
Missing or oversized evidence leaves the referral pending. The delegate actor `referral-ruler`
is automation-authored (R1035), never an operator; it may only card or block pending findings,
cannot supersede a ruling, and cannot clear human review. The writer requires the expected head and a poster stamp bound to the registered automation login.
Delegate cards use the shared card classification restrictions: fix-now and security classes may
only block or escalate, even under a permissive class policy. Unknown, malformed or protected
history refuses a delegate write; protection is checked again immediately before writing.
Delegate blocks participate in the ignored-ruling escalation ladder; carried cards keep delegate attribution.
The sweep re-reads eligibility before every write; stale heads, disputes, judgment calls and human
clearances remain untouched. The older auto-block pass must not consume escalated referrals.
`review.referralDefault=operator` and `WE_REFERRAL_AUTO_RULE=0` disable this path. Invalid settings
fail closed. Settings use the shared policy cascade. Each spawn consumes one host start and live
review seat, obeys the host per-tick cap, and uses the shared judge model/effort routing.
The soak break detects fix presence by Git ancestry independently of its behavioural probe.
Hermetic unit and soak tests inject capacity, model output and the sanctioned ruling CLI seam.
