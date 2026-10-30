/** The derived dispatch-path set: every file a fix / ci-heal / review worker launch runs through. A setting
 *  (`overlaySafety.dispatchPaths` in daemon-rebuild-settings.json, or `WE_OVERLAY_DISPATCH_PATHS`). */
export const DISPATCH_PATH_DEFAULTS = Object.freeze([
  'scripts/operations/dispatch-lane-io.mjs',
  'scripts/operations/dispatch-lane.mjs',
  'scripts/operations/worker-wrapper*.mjs',
  'scripts/operations/detached-dispatch.mjs',
  'scripts/operations/review-dispatch.mjs',
  'scripts/operations/review-job*.mjs',
  'scripts/operations/ci-heal-pr-dispatch.mjs',
  'scripts/operations/completion-*.mjs',
  'scripts/operations/deliver-item-wrapper.mjs',
  'scripts/operations/session-role.mjs',
  'scripts/operations/dispatch-providers/*.mjs',
  'scripts/conveyor/reconcile-fix-dispatch.mjs',
  'scripts/lib/dispatch-bg-isolation.mjs',
  'scripts/lib/gh-app-shim.mjs',
  'scripts/lib/spawn-to-completion.mjs',
  'scripts/lib/advisor-trial.mjs',
  'scripts/lib/provider-routing.mjs',
  'skills-src/conveyor/dispatched-agent-system-prompt.md',
]);

