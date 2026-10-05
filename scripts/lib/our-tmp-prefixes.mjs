// This list is the ONE place the sweep's allowlist lives.
// Add a prefix only after proving (git grep) that our code creates it.
export const OUR_TMP_PREFIXES = Object.freeze(`
we-coord-test we-gh-throttle-test we-fake-gh we-daemon-state-test pr-snapshot gh-t gh-personal-route
we-overlay-cli-author pr-snapshot-gh gh-rest-read pr-view-transport gh-budget merge-ai-prs-dedupe-log
we-overlay-cli-state we-overlay-cli-fixture we-telemetry drain-other drain-origin gh-sync-cap gh-cost gh-spend
gh-spend-rot we-codex-task-tmp we-daemon-overlays-git we-daemon-overlays-author dispatch-plan-prlimit
dispatch-lane-io-defaults-gh dispatch-lane-io-defaults spend-interval we-overlay-lock-root we-overlay-lock
review-log-claims pr-authorship gh-t-failopen sim-template-we-bare gh-cap-buf full-suite-escape tt-det
load-admission-empty sim-world gh-t-home gh-t-failopen-log gh-spend-sync we-scan-bridge-test gh-cap-log
gh-rest-read-gh tel-unwritable no-git open-pr-fetch-rest-gh open-pr-fetch-rest sim-template-we
we-gemini-direct-test we-cr-hook pr-events-status pr-events we-dt-hook review-corpus-golden agy-scorecard-test
shim-owner agent-action sim-clock per-owner conveyor-pr-file-test session-reaper-guard1c-isolated
`.trim().split(/\s+/));

export function ourTmpEntryPattern(prefixes = OUR_TMP_PREFIXES) {
  const escaped = prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^(?:${escaped.length ? escaped.join('|') : '(?!)'})[-_.][A-Za-z0-9]{6}$(?![\\s\\S])`);
}
