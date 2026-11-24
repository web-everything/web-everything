## Live-owner review adapter collection

`pr-live-owner-watch.test.mjs` imports the manual dispatcher, review job and reconcile
graph statically during collection. The first `review-dispatch` case otherwise loads
these roots inside its five-second deadline, even when dispatch and reconcile IO are
injected. Keep the production adapters exercised with injected effects and retain the
original test deadlines and head-pinning assertions; avoid charging cold module loading
to the first adapter case.
