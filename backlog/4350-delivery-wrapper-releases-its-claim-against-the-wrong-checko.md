---
bornAs: xwgnold
kind: story
size: 2
priority: high
status: open
scaffoldedBy: "investigate-dispatch-noop-lane-3-d65b5d9a"
dateScaffolded: "2026-09-28"
scope: ["we:scripts/operations/deliver-item-wrapper.mjs", "we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs"]
dateOpened: "2026-09-28"
tags: ["build-dispatch"]
---

# Delivery wrapper releases its claim against the wrong checkout: claim runs in the lane, release runs in the wrapper's own clone and is refused

The delivery wrapper claims the card inside the WE lane (`claimItem({ lanePath })`, cwd = lane). But `releaseClaimAndLane` runs `we:scripts/backlog.mjs` `release <item>` with no cwd. So the release runs in the wrapper's own process checkout (the daemon clone `wev-control`), where the card is still `open`. The release is refused on every exit path. The failure is swallowed (`try { … } catch {}`) and the claim that did happen is never undone in the same place. Also, `claimItem` ignores the claim's own result, so a claim that silently did nothing is not caught either.

## Evidence (2026-09-28, live)

- `wev-control/.operations/delivery-dispatch-logs/conveyor-2720.log` and `conveyor-3604.log` both show, on release: `✗ #2720 — status is "open", expected "active" or "preparing" — only an in-flight claim is released` (and the same for #3604).
- Code, in `we:scripts/operations/deliver-item-wrapper.mjs`: L560-561 claim runs `we:scripts/operations/run.mjs` `claim --ref=<item>` with `{ cwd: lanePath }`. L580 release runs `we:scripts/backlog.mjs` `release <item> --session=<slug>` with no cwd, inside a swallowing `catch`.

## Scope

- Run the release with the same `cwd` as the claim (`resolveLanePath(lane)`), on every exit path.
- Check the claim's own result. A claim that did not move the card to `active` fails the delivery before spawning an agent (`blocked-on-infra`), instead of building on an unclaimed card.

## Risks

- A lane that was already reset or released before the release call. Keep it best-effort on the failure path, but log the refusal instead of swallowing it silently.

## Done when

1. **Executable** — a new case in `we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs` asserts that `releaseClaimAndLane` runs the release with `cwd` equal to the same lane path `claimItem` used. It fails today (no cwd) and passes after.
2. A test where the claim returns a non-`active` result: the wrapper stops before `provider.spawn`.
3. **Live proof** — a real builder dispatch that ends early (for example `not-ready`): the wrapper log shows the release succeeding (no `status is "open", expected "active"` line), and the card's status is back to `open` in the lane it was claimed in.
