## Forge pool grow failure fixtures

`forge-slots.test.mjs` executes setup's account/directory preparation and final
enable transaction with host IO stubbed. New directories use `.disabled-slot-N`:
old and new runners discover only `slot-N`. Sudoers is prepared privately and
published only after the installed runner verifies every target UID's egress.
Keep failure cases before runner replacement as well as during final publication;
restoring an old refresh timer must never make the staged slots discoverable.

