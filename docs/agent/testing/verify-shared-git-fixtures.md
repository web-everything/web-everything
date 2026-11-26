## Shared verification Git fixtures

When a verifier rejects inherited Git configuration, keep its simulated process environment
separate from the test's real Git IO environment. Removing `GIT_CONFIG_*` from both restores
runner system/global filters, so a positive fixture can fail on hosts with Git LFS installed.
Inject the Git port with empty global config and system config disabled; retain production
hardening pins and repository-local config. Exercise configured filters through a separate
negative port, and assert successful publication emits no skip diagnostic.

Policy helper imports must not spawn Git before CLI validation. Entry points explicitly
initialize the immutable verifier identity before repository work or admission; tests should
initialize it at the same boundary and prove later changes cannot refresh the snapshot.
