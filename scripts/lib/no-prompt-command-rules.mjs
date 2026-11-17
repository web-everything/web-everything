/** Shared command discipline for sessions running under the operator's Claude permissions.
 * Markdown and sandbox workflow copies are pinned by no-prompt-command-rules.test.mjs.
 */
export const NO_PROMPT_COMMAND_RULES_SENTINEL = '<!-- no-prompt-command-rules:begin -->';
export const NO_PROMPT_COMMAND_RULES_END = '<!-- no-prompt-command-rules:end -->';
export const NO_PROMPT_COMMAND_RULES_GENERATED_COMMENT = '<!-- Generated from scripts/lib/no-prompt-command-rules.mjs; whole-tree test pins this copy. -->';
export const NO_PROMPT_COMMAND_RULES_BODY = `## No-prompt command rules

- Plain single commands only: no \`$(...)\`, no shell variables or arrays, no loops, no trailing \`&\`.
- Edit files with the Edit/Write tools, never \`sed -i\`, \`perl -i\`, or redirect writes.
- Never \`rm -rf\` / \`rm -r\`: write scratch to a NEW uniquely named dir instead of deleting.
- Never run destructive history or working-tree resets, forced pushes, or cleans.
- Stop background jobs with the job tool (TaskStop), never \`pkill\`/\`killall\`.`;
export const NO_PROMPT_COMMAND_RULES = `${NO_PROMPT_COMMAND_RULES_SENTINEL}\n${NO_PROMPT_COMMAND_RULES_BODY}\n${NO_PROMPT_COMMAND_RULES_END}`;

/** Shared with the launch-brief syntax audit: preserve its existing executor signature. */
export const CLAUDE_LAUNCH_EXECUTOR_PATTERN = /(?:spawn|exec|run)/i;
export const CLAUDE_SCRIPT_LAUNCH_PATTERNS = Object.freeze({
  py: /["']claude["']/g,
  sh: /\bclaude\s+(?:-p|--print|--bg)\b/g,
});

/** Indirect launch boundaries whose argv is rendered by the named caller. Counts fail closed on growth. */
export const LAUNCH_RENDERER_ALLOWLIST = Object.freeze({
  'scripts/operator/converge.py': {
    count: 1,
    reason: 'The run_agent subprocess boundary renders its prompt with render_no_prompt_command_rules; the generated Python helper is pinned separately.',
  },
  'scripts/operations/dispatch-lane-io.mjs': {
    count: 6,
    reason: 'Three argv-only transport calls consume buildAgentArgv headers; the other signatures are an injected provider, an executor report, and an agents listing.',
  },
  'scripts/operations/explore-io.mjs': {
    count: 2,
    reason: 'The argv-only spawner consumes composeInvestigationPrompt headers; the second call only lists existing agents.',
  },
  'scripts/operator/dispatch.mjs': {
    count: 1,
    reason: 'The shared spawn helper receives the FIX, CI_HEAL or REVIEW prompt rendered by its caller.',
  },
  'scripts/probes/worker-result-probe.mjs': {
    count: 2,
    reason: 'The background probe forwards caller argv containing rendered PROMPT/PROMPT2; its other call stops that probe.',
  },
});

/** Validate the task itself before the builder adds any instructions. */
export function assertBriefTaskContent(task) {
  if (typeof task !== 'string') throw new TypeError('no-prompt rules require a string brief');
  if (!task.trim()) throw new Error('empty task content — refusing an empty or whitespace-only task');
  return task;
}

/** R115: the builder owns this fixed header; task text never controls its inclusion. */
export function renderNoPromptCommandRules(task) {
  assertBriefTaskContent(task);
  return `${NO_PROMPT_COMMAND_RULES}\n\n${task}`;
}

/** Generated import-free runtime for workflow sandboxes; pinned by the whole-tree test. */
export function renderNoPromptCommandRulesRuntime() {
  return [
    `const NO_PROMPT_COMMAND_RULES = ${JSON.stringify(NO_PROMPT_COMMAND_RULES)};`,
    assertBriefTaskContent.toString(), renderNoPromptCommandRules.toString(),
  ].join('\n');
}

/** Authored Claude launch briefs, including sandbox/Markdown copies. */
export const LAUNCH_BRIEF_SOURCES = Object.freeze([
  "scripts/conveyor/await-verify-pass.mjs",
  "scripts/conveyor/convert-advisory-dispatch.mjs",
  "scripts/conveyor/fix-context-pack.mjs",
  "scripts/conveyor/fix-resume.mjs",
  "scripts/conveyor/health-investigate-dispatch.mjs",
  "scripts/conveyor/main-ci-red-core.mjs",
  "scripts/conveyor/prep-review.mjs",
  "scripts/conveyor/reconcile-fix-dispatch.mjs",
  "scripts/conveyor/referral-reverify.mjs",
  "scripts/conveyor/stuck-pr-inspect-dispatch.mjs",
  "scripts/lib/brief-red-team.mjs",
  "scripts/lib/build-self-review.mjs",
  "scripts/lib/converge-transports.mjs",
  "scripts/lib/daemon-load-overlay.mjs",
  "scripts/lib/decision-prose-adapter.mjs",
  "scripts/lib/design-pixels-adapter.mjs",
  "scripts/lib/judge-spawn.mjs",
  "scripts/lib/jury-core.mjs",
  "scripts/lib/review-core.mjs",
  "scripts/operations/ci-heal-pr-dispatch.mjs",
  "scripts/operations/coroner-judge.mjs",
  "scripts/operations/coroner-sample.mjs",
  "scripts/operations/deliver-item-wrapper.mjs",
  "scripts/operations/dispatch-lane-io.mjs",
  "scripts/operations/dispatch-lane.mjs",
  "scripts/operations/explore-io.mjs",
  "scripts/operations/explore.mjs",
  "scripts/operations/fix-run.mjs",
  "scripts/operations/maintenance-io.mjs",
  "scripts/operations/operator-session-bootstrap-io.mjs",
  "scripts/operations/operator-session/pr-movement-sweep.prompt.md",
  "scripts/operations/operator-task-brief.mjs",
  "scripts/operations/perf-velocity-io.mjs",
  "scripts/operations/probation-build-run.mjs",
  "scripts/operations/record-referral-ruling-io.mjs",
  "scripts/operations/review-dispatch.mjs",
  "scripts/operations/review-extra-seats.mjs",
  "scripts/operations/review-prep.mjs",
  "scripts/operations/worker-wrapper.mjs",
  "scripts/operator/converge.py",
  "scripts/operator/dispatch.mjs",
  "scripts/probes/worker-result-probe.mjs",
  "scripts/worker-brief.mjs",
  "scripts/workflows/review-parked-prs.mjs",
  "skills-src/batch-backlog-items/SKILL.md",
  "skills-src/batch-backlog-items/parallel-execute.workflow.js",
  "skills-src/brand-mark-loop/SKILL.md",
  "skills-src/build-ui/SKILL.md",
  "skills-src/converge/SKILL.md",
  "skills-src/conveyor/SKILL.md",
  "skills-src/conveyor/canary-agent-brief.md",
  "skills-src/conveyor/delivery-agent-brief-v2.md",
  "skills-src/conveyor/delivery-agent-brief.md",
  "skills-src/conveyor/dispatched-agent-system-prompt.md",
  "skills-src/conveyor/fix-agent-brief.md",
  "skills-src/conveyor/fix-agent-ci-brief.md",
  "skills-src/conveyor/health-investigate-brief.md",
  "skills-src/conveyor/investigation-agent-brief.md",
  "skills-src/conveyor/opus-sweep-brief.md",
  "skills-src/conveyor/prepare-decision-agent-brief.md",
  "skills-src/conveyor/prepare-item-agent-brief.md",
  "skills-src/conveyor/prepare-item-worker-brief.md",
  "skills-src/conveyor/prepare-scope-agent-brief.md",
  "skills-src/conveyor/role-test-soak-author-brief.md",
  "skills-src/conveyor/stuck-pr-inspect-brief.md",
  "skills-src/conveyor/stuck-pr-inspect-system-prompt.md",
  "skills-src/drain/SKILL.md",
  "skills-src/harvest-learnings/SKILL.md",
  "skills-src/jury/SKILL.md",
  "skills-src/jury/panel-fanout.mjs",
  "skills-src/jury/subject-jury.workflow.js",
  "skills-src/next-backlog-item/SKILL.md",
  "skills-src/prepare-decision-item/SKILL.md",
  "skills-src/review/SKILL.md",
  "skills-src/review/review-agent-brief.md",
  "skills-src/review/review-agent-system-prompt.md",
  "skills-src/worker-brief/SKILL.md"
]);

/** Detected non-briefs and provider-only paths: every exception needs a reason. */
export const LAUNCH_BRIEF_EXCLUSIONS = Object.freeze({
  "scripts/conveyor/canary.mjs": "Fills the registered canary-agent-brief through fillBrief; no separately authored prompt.",
  "scripts/conveyor/prep-review-io.mjs": "Passes prep-review mandates unchanged to the shared judge transport.",
  "scripts/lib/dispatch-smoke-launch.mjs": "Forwards daemon-load-overlay smoke prompts through the shared dispatch boundary.",
  "scripts/operations/worker-wrapper-launch.mjs": "Converts shared dispatch argv and forwards resume requests; worker-wrapper appends rules on resume.",
  "scripts/autofix/modelFixer.mjs": "Hosted Anthropic HTTP completion client; no Claude Code session or shell tools.",
  "scripts/check-standards-rules.mjs": "Static mandate lint, not a prompt producer.",
  "scripts/codex-direct-task.mjs": "Codex-only direct task prompt.",
  "scripts/gemini-direct-task.mjs": "Antigravity Gemini-only direct task prompt.",
  "scripts/converge-cli.mjs": "Routes shared review-core mandates and converge-transports editor prompts unchanged.",
  "scripts/conveyor/brief-rule-ledger.mjs": "Audits authored briefs; never dispatches one.",
  "scripts/conveyor/canary-stages.mjs": "Detects permission stalls in existing transcripts; no prompt producer.",
  "scripts/conveyor/claude-auth-health.mjs": "Claude auth status probe; no session launch.",
  "scripts/conveyor/driver-watchdog.mjs": "Lists existing Claude agents; no session launch.",
  "scripts/conveyor/health-smells/dispatch-permission-stall.mjs": "Detects permission stalls in transcripts; no prompt producer.",
  "scripts/conveyor/health-watch.mjs": "Lists existing Claude agents; investigation prompts belong to health-investigate-dispatch.",
  "scripts/conveyor/liveness-sweep.mjs": "Lists/stops existing agents; no session launch.",
  "scripts/conveyor/main-ci-red-io.mjs": "Dispatches main-ci-red-core authored briefs unchanged.",
  "scripts/conveyor/orphan-claim-release.mjs": "Reads existing Claude agents; no session launch.",
  "scripts/conveyor/pool-exhaustion.mjs": "Reads existing Claude agents; no session launch.",
  "scripts/conveyor/reconcile-pass.mjs": "Reads existing Claude agents and plans work; no prompt producer.",
  "scripts/conveyor/session-reaper.mjs": "Stops existing agents; no session launch.",
  "scripts/conveyor/session-watchdog.mjs": "Reads/stops existing agents; no session launch.",
  "scripts/lane-whois.mjs": "Reads existing Claude agents; no session launch.",
  "scripts/lib/advisor-trial.mjs": "Adds advisor context to an existing brief; buildAgentArgv appends shared rules after this transform.",
  "scripts/lib/agy-review-juror.mjs": "Antigravity-only transport; native Claude judge path uses judge-spawn.",
  "scripts/lib/antigravity-judge-spawn.mjs": "Antigravity-only transport, not Claude Code.",
  "scripts/lib/claude-sessions.mjs": "Reads session metadata and prompt history; no launch.",
  "scripts/lib/codeql-gate.mjs": "Optional CodeQL data section of the ci-heal brief, not a standalone prompt.",
  "scripts/lib/codex-judge-spawn.mjs": "Codex-only judge transport.",
  "scripts/lib/daemon-rebuild/auto-rebase.mjs": "Brief in a Git decision result means an explanatory summary, not an agent prompt.",
  "scripts/lib/fix-executor-chain.mjs": "Resolves provider rung data; no prompt or session launch.",
  "scripts/lib/judge-panel.mjs": "Passes caller mandates to judge-spawn, which appends the shared block.",
  "scripts/lib/lane-salvage.mjs": "Lists existing agents and emits salvage context fragments; no standalone prompt.",
  "scripts/lib/mandate-fence-scan.mjs": "Static mandate lint, not a prompt producer.",
  "scripts/lib/no-prompt-command-rules.mjs": "Canonical rule text and coverage registry, not a session launcher.",
  "scripts/lib/operator-send-backs.mjs": "Optional findings/context fragment in an existing brief; no standalone launch prompt.",
  "scripts/lib/pr-state-io.mjs": "Reads existing Claude agents; no session launch.",
  "scripts/lib/review-precedents-io.mjs": "Lists existing Claude agents; no session launch.",
  "scripts/lib/ruling-ledger.mjs": "Optional ruling context fragment in an existing fixer brief; no standalone launch prompt.",
  "scripts/measure-judge-spawn.mjs": "Benchmark passes mandates through buildJudgeArgv/judgeSpawn, both covered by judge-spawn.",
  "scripts/operations/cli-adapter.mjs": "Provider-neutral routing of existing request mandates; native Claude uses judge-spawn.",
  "scripts/operations/coroner-transcripts.mjs": "Reads/classifies historical briefs and transcripts; no session launch.",
  "scripts/operations/dispatch-abort.mjs": "Stops existing agents; no session launch.",
  "scripts/operations/land-advance-io.mjs": "Reads existing agents and invokes dispatchers; no authored brief.",
  "scripts/operations/operator-controls-io.mjs": "Reads/stops existing agents; no session launch.",
  "scripts/operations/operator-why-io.mjs": "Reads agent state for explanations; no session launch.",
  "scripts/operations/review-pr-io.mjs": "Extends shared review mandates and dispatches through judge-spawn.",
  "scripts/operations/review-pr.mjs": "Advisory prompts compose shared review-core mandates; native Claude uses judge-spawn.",
  "scripts/review-core-cli.mjs": "CLI renders shared review-core mandates; no separately authored prompt.",
  "skills-src/jury/resolve-roster.mjs": "Resolves roster data via shared subject adapters; no standalone prompt.",
  "skills-src/capability-search/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/capture-learning/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/closing-session/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/consolidate-backlog-items/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/context-sweep/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/coroner/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/decision-docket/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/design-committee/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/exercise-app/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/file-item/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/finish/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/free-scope/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/gap-sweep-rerun/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/held-cards/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/inspect-agent-health/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/inspect-codex-transcript/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/mechanical-delivery-doctrine/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/merge/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/new-demo/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/new-standard/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/pr/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/pr-reconcile/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/progress-board/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/prototype-load/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/prototype-tracker/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/queue/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/review-design/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/review-program/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/runner-status/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/split-backlog-item/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/stale-ratified-status/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/stale-state/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/state/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/use-codex/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/use-gemini/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates.",
  "skills-src/why-not-dispatching/SKILL.md": "Operator playbook, not a dispatched brief; session prompts come from the registered builders/templates."
});
