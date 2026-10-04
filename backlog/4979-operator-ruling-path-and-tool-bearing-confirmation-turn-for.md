---
bornAs: x5w7u24
kind: story
size: 8
status: resolved
scope: ["we:scripts/lib/jury-core.mjs", "we:scripts/operations/review-pr.mjs", "we:scripts/operations/review-pr-io.mjs", "we:scripts/lib/__tests__/jury-core.test.mjs", "we:scripts/operations/__tests__/review-pr.test.mjs", "we:scripts/operations/__tests__/review-pr-io.test.mjs"]
dateOpened: "2026-10-02"
dateStarted: "2026-10-04"
dateResolved: "2026-10-04"
tags: []
---

# Implement the tool-bearing confirmation turn for review findings (split from #3507)

This card owns the entire tool-bearing confirmation turn removed from PR #3507. On 2026-10-03 the operator approved ("Ok") stripping confirmation from #3507 and moving it here. #3507 retains cross-run ruling/record handling and the operator ruling path (block / card / not-real); ordinary automated referrals use main's tool-free ruling behavior in the interim. The assigned independent reviewer and operator remain responsible for those rulings; no automated reproduction is claimed.

## Deferred design

Reintroduce confirmation as a separate, isolated feature: identify unsupported tool-less CONFIRMED claims, retain their original finding while presenting them as PLAUSIBLE advice, and attach a durable `confirmationRequired` obligation to serious claims. Dispatch one bounded tool-bearing correctness turn for a record containing such claims, persist its attempt before dispatch, and require finding-specific block / card / not-real evidence before clearing its hold. Ordinary referrals remain tool-free and require no checkout. Handle malformed findings without crashing or treating them as a clean bill.

The removed implementation included `runReferralJudge`, `read.referralCwd` propagation, detached checkout positioning, a host-git isolation helper, content fingerprints for tracked/untracked files and Git metadata, and a post-turn tamper check. Those mechanisms are design context, not an approved security boundary. Do not restore the caller-checkout positioning or the point-in-time guard.

## Acceptance and open review findings

- Provision a fresh isolated checkout at the full reviewed head SHA for each confirmation turn. Never use the caller's checkout, the driver's checkout, or `REPO_ROOT`; never run `git checkout` on the driver's own checkout. Missing heads or provisioning failures retain the hold.
- Run tools in the juror sandbox with bounded credentials and egress. Use a continuous or process-scoped tamper guard covering the entire turn and host verification, including failure/timeout cleanup. No child or background process may outlive the turn. A before/after metadata comparison alone does not close the race.
- Neutralize host Git system/global configuration, inherited `GIT_*` routing/config injection, global/system attributes, hooks, fsmonitor, clean/smudge/process filters and diff/textconv drivers before every host Git call, including discovery and checkout. Account for local configuration and attributes as well. The prior design used `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_ATTR_NOSYSTEM=1`, and explicit core/filter overrides; prove the replacement boundary rather than assuming those flags suffice.
- Protect common and per-worktree Git metadata, config, hooks, info attributes, `.git` pointers and Git-directory indirection before any host Git command can consume attacker-controlled state.
- Verify by content hash: tracked raw bytes, index state/hidden flags, pre-existing untracked contents, symlink targets, and protected Git metadata. Porcelain paths, timestamps, or filtered Git comparisons are insufficient. Permit untouched artifacts while rejecting overwritten probes and attribute-hidden edits.
- History must never lower a new claim's `confirmationRequired`, on either the same head or a changed head. Legacy unflagged entries, covered keys and earlier diff-only not-real rulings cannot discharge a new confirmation obligation. Record tool-bearing evidence provenance, including the command and observed result; unavailable verification leaves the hold pending.
- Preserve append-only ruling history, reviewer independence, trusted-comment filtering, trailer-only parsing, unrelated holds and the #3432 replay. Define explicit authorized supersession if conflicting exact-key same-head rulings across records need resolution; reject foreign/stale supersedes references. Do not let this feature weaken the retained operator ruling boundary. The earlier review also requires out-of-band operator authentication tied to an `OPERATOR_LOGINS` login distinct from automation, rather than self-declared actor/channel/reason; exercise the author-agent self-clear attack when integrating confirmation with that boundary.

Source reviews: https://github.com/chalbert/web-everything/pull/3507#issuecomment-5955906262 and https://github.com/chalbert/web-everything/pull/3507#issuecomment-5957062573. This plan supersedes the earlier combined operator/confirmation scope of this card.

## Test plan and done criteria

1. Restore the removed confirmation test intent using real temporary repositories: a caller on another commit remains byte-for-byte unchanged while a fresh checkout reaches the reviewed head; missing heads, dirty tracked files and assume-unchanged/skip-worktree entries cannot bypass verification. Ordinary referrals invoke no checkout or host Git probes.
2. Test tracked edits, overwritten untracked probes, untouched lane artifacts, unreadable untouched files, ignored attributes that normalize away raw edits, linked-worktree pointer redirection, and common/per-worktree metadata tampering. Plant global/system/local filters, hooks and configuration and prove payloads never execute during any host call.
3. Exercise transient tamper-and-restore and delayed background writers, including thrown judge errors and timeouts. Prove process cleanup and continuous protection, not merely matching snapshots after return.
4. Exercise mixed plain/confirmation records (one durable attempt), same-head legacy clearance, old-head replay, stronger new claims and unavailable verification across restarts. Verify source, documentation, configuration and data findings; block and missing evidence retain their holds, card requires a readable durable reference, and not-real requires the appropriate evidence provenance.
5. Demonstrate regressions failing before implementation, then pass `we:scripts/lib/__tests__/jury-core.test.mjs`, `we:scripts/operations/__tests__/review-pr-io.test.mjs`, `we:scripts/operations/__tests__/review-pr.test.mjs` and `we:scripts/__tests__/review-set-label.test.mjs`. Exercise the real sandbox/provisioning/cleanup path end to end before declaring completion. Stale heads, unreadable evidence, tampering and incomplete publication must preserve the mandatory hold for every input kind.

## Progress — operator ruling path (2026-10-04)

This part was delivered first because PR #3771 was stuck on it. The operator said on 2026-10-04 ~10:35 ET: "make sure all PRs move". An operator can now rule block, card or not-real on a mandatory referral through one sanctioned writer: the `record-referral-ruling` operation (we:scripts/operations/record-referral-ruling.mjs). The gate, `we:scripts/lib/jury-core.mjs#mandatoryReferralState`, reads these rulings alongside reviewer rulings. A ruling counts only if all of these hold:

- A trusted principal posted the exact rendered record.
- Its actor is an `OPERATOR_LOGINS` login.
- It names the PR, head, referral run and finding it rules on.

The latest operator ruling on that exact finding supersedes the reviewer's. A new head drops it. `card` needs a readable we:backlog card.

The actor, channel and operator words are a recorded assertion, as with `clear-human` (the #2895 honesty tax). They are not out-of-band authentication. That stronger boundary stays with the confirmation turn. The tool-bearing confirmation turn above is still open.
