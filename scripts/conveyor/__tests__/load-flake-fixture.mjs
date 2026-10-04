import { STAND_DOWN_MARKER } from '../stand-down.mjs';
export const loadFlakeLegacyBody = `${STAND_DOWN_MARKER}

conveyor fix agent stopped rather than guessing: the gate stayed RED after the repair, and a red diff must never be re-pushed. fix ready on lane/fix-polluted-branch-scope-read-fix-3881-alt (9202eee8a); soak red-green PROVEN; verify red ONLY on docket-refresh.test.mjs 5s timeout (passes alone 24/24, load avg 25-36) = load flakiness for quarantine card 4999, per operator ruling not edited here; an earlier verify run rotated through other load timeouts (progress-board, probation-launcher, dispatch-plan, reconcile-pass, session-reaper) that all pass alone. Verify never went green, so not pushed to the PR head: push the alt-branch tip once verify is green or card 4999 lands

The PR was left EXACTLY as the reviewer left it — no label was changed, the review was not re-armed, and nothing was re-pushed. This comment is the durable record that a fixer *deliberately stood down* here, which is what tells the reconciler apart from a fixer that simply died.

**A human is the intended next step.** The automatic fix loop will NOT try this PR again while this comment stands — re-running it would only re-ask the same question. Take it over with \`/finish\`, or delete this comment once the blocker is resolved to hand the PR back to the loop.
<!-- stand-down reason=gate-red -->`;
