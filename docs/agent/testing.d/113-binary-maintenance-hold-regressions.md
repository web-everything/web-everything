## Binary maintenance hold regressions

Keep binary health/cache under the evidence directory's `binary/` subfolder; root JSON names remain legacy quota observations. Test unreadable health as a closed hold, recovery followed by an identical outage through the real attention publisher, and refused child kills at every maintenance step with reporting before lock release.

Register binary maintenance's exclusive lock in `LOCK_HOLDERS` in `scripts/lib/audit-settings.mjs`.
The source scan in `scripts/operations/__tests__/audit-verdict.test.mjs` requires every lock holder
to stay on the protected audit floor, so concurrency findings block publication.
