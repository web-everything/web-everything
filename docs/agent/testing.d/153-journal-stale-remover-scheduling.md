## Journal stale-remover scheduling

The validation/unlink regression in `scripts/lib/__tests__/delivery-policy.test.mjs`
releases the replacement writer when the stale unlink completes. Waiting for the
first writer's whole append can exhaust its lock budget if the second writer owns
the replacement. Cover that acquisition order with a worker barrier after the
generation guard releases, for both normal capacity and a single remaining record.
At the size limit, assert exactly one append and the matching journal identity;
either writer may win unless the fixture explicitly orders acquisition.
