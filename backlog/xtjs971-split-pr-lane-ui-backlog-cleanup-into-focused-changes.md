---
kind: story
size: 3
status: open
scope: ["we:backlog/2209-ratify-the-constellation-branding-system-naming-marks-icon-r.md", "we:backlog/2446-where-does-plateau-loop-live-plateau-app-module-own-repo-or-.md", "we:backlog/2465-plateau-loop-config-over-convention-gating-review-drain-mode.md", "we:backlog/2472-plateau-loop-multi-project-registry-manage-we-frontier-ui-an.md", "we:backlog/2811-real-route-conformance-test-plateau-app.md", "we:backlog/2834-remediate-the-console-board-flip-the-2811-real-route-conform.md", "we:backlog/3736-wip-report-compact-phone-first-tables-and-attention-findings.md", "we:backlog/4007-plateau-wip-dashboard-shows-live-plan-steps-per-card.md", "we:backlog/4057-wip-fleet-panel-pr-ownership-rows-and-a-why-is-nothing-dispa.md", "we:backlog/4199-wip-page-per-card-activity-panel-listing-sessions-and-jobs-r.md", "we:backlog/4202-wip-page-a-durable-not-delivered-by-n-dismissal-for-a-strand.md", "we:backlog/4901-render-all-plateau-pr-waits-and-cached-pages-in-the-phone-fl.md", "we:backlog/4984-prevent-horizontal-elastic-scroll-on-mobile-in-the-wip-page.md", "we:backlog/4996-add-a-discard-action-for-requests-on-the-wip-page.md", "we:backlog/4997-prevent-pinch-and-double-tap-zoom-on-mobile-for-the-wip-page.md", "we:backlog/5358-wip-deep-links-card-n-highlights-a-card-agent-session-opens.md", "we:backlog/5377-add-mobile-friendly-navigation-menu-to-wip-and-related-pages.md", "we:backlog/5593-wip-deep-links-apply-card-and-agent-only-to-the-real-snapsho.md", "we:backlog/xf99xv7-ui-requirements-carried-from-closed-wip-cards.md", "we:backlog/xkjijbm-pd-fui-5-option-frame-with-100-view-we-option-frame.md", "we:backlog/xksajth-pd-fui-3-status-card-with-source-word-tag-we-status-card.md", "we:backlog/xn4er4k-pd-fui-4-detail-sheet-we-detail-sheet.md", "we:backlog/xnpd8wr-pd-fui-7-heat-strip-we-heat-strip.md", "we:backlog/xqganip-pd-fui-6-rung-navigation-we-rung-nav.md", "we:backlog/xr0qe34-pd-fui-2-milestone-flags-we-milestone-flag.md", "we:backlog/xrf4ker-pd-fui-1-time-tracks-block-we-time-tracks.md", "we:docs/agent/platform-decisions.md"]
dateOpened: "2026-11-22"
tags: []
---

# Split PR lane/ui-backlog-cleanup into focused changes

size-split-key:dcba9adcf14de9763733e0afa3e07a130e9df614f35c8978415afec7536b2b75. Plan follow-up splits for PR lane/ui-backlog-cleanup. File groups: we:backlog/2209-ratify-the-constellation-branding-system-naming-marks-icon-r.md: 1; we:backlog/2446-where-does-plateau-loop-live-plateau-app-module-own-repo-or-.md: 4; we:backlog/2465-plateau-loop-config-over-convention-gating-review-drain-mode.md: 4; we:backlog/2472-plateau-loop-multi-project-registry-manage-we-frontier-ui-an.md: 4; we:backlog/2811-real-route-conformance-test-plateau-app.md: 4; we:backlog/2834-remediate-the-console-board-flip-the-2811-real-route-conform.md: 4; we:backlog/3736-wip-report-compact-phone-first-tables-and-attention-findings.md: 5; we:backlog/4007-plateau-wip-dashboard-shows-live-plan-steps-per-card.md: 5; we:backlog/4057-wip-fleet-panel-pr-ownership-rows-and-a-why-is-nothing-dispa.md: 5; we:backlog/4199-wip-page-per-card-activity-panel-listing-sessions-and-jobs-r.md: 5; we:backlog/4202-wip-page-a-durable-not-delivered-by-n-dismissal-for-a-strand.md: 5; we:backlog/4901-render-all-plateau-pr-waits-and-cached-pages-in-the-phone-fl.md: 5; we:backlog/4984-prevent-horizontal-elastic-scroll-on-mobile-in-the-wip-page.md: 5; we:backlog/4996-add-a-discard-action-for-requests-on-the-wip-page.md: 5; we:backlog/4997-prevent-pinch-and-double-tap-zoom-on-mobile-for-the-wip-page.md: 5; we:backlog/5358-wip-deep-links-card-n-highlights-a-card-agent-session-opens.md: 5; we:backlog/5377-add-mobile-friendly-navigation-menu-to-wip-and-related-pages.md: 5; we:backlog/5593-wip-deep-links-apply-card-and-agent-only-to-the-real-snapsho.md: 5; we:backlog/xf99xv7-ui-requirements-carried-from-closed-wip-cards.md: 517; we:backlog/xkjijbm-pd-fui-5-option-frame-with-100-view-we-option-frame.md: 40; we:backlog/xksajth-pd-fui-3-status-card-with-source-word-tag-we-status-card.md: 40; we:backlog/xn4er4k-pd-fui-4-detail-sheet-we-detail-sheet.md: 40; we:backlog/xnpd8wr-pd-fui-7-heat-strip-we-heat-strip.md: 41; we:backlog/xqganip-pd-fui-6-rung-navigation-we-rung-nav.md: 40; we:backlog/xr0qe34-pd-fui-2-milestone-flags-we-milestone-flag.md: 41; we:backlog/xrf4ker-pd-fui-1-time-tracks-block-we-time-tracks.md: 40; we:docs/agent: 4

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
