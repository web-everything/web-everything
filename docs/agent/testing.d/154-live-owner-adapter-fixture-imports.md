## Live-owner adapter fixture imports

Load the manual dispatcher, review job and reconcile graph during collection in
`pr-live-owner-watch.test.mjs`. The real review adapter imports these modules even
when dispatch and reconcile IO are injected, so a cold transform otherwise consumes
the first case's five-second deadline. Reuse the collected modules in head-change
and job-refusal cases; retain injected launch IO, assertions and per-case deadlines.

