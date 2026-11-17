/** Shared command discipline for sessions running under the operator's Claude permissions.
 * Markdown and sandbox workflow copies are pinned by no-prompt-command-rules.test.mjs.
 */
export const NO_PROMPT_COMMAND_RULES_SENTINEL = '<!-- no-prompt-command-rules:begin -->';
export const NO_PROMPT_COMMAND_RULES_END = '<!-- no-prompt-command-rules:end -->';
export const NO_PROMPT_COMMAND_RULES_GENERATED_COMMENT = '<!-- Generated from scripts/lib/no-prompt-command-rules.mjs; whole-tree test pins this copy. -->';
export const NO_PROMPT_COMMAND_RULES_BODY = `## No-prompt command rules

- Plain single commands only: no \`$(...)\`, no shell variables or arrays, no loops, no trailing \`&\`.
- Edit files with the Edit/Write tools, never \`sed -i\`, \`perl -i\`, or redirect writes.
- Never \`rm -rf\` / \`rm -r\`: write scratch into a NEW uniquely named dir instead of deleting.
- Never \`git reset --hard\`, \`git push --force\`, \`git clean\`. To continue a branch in a lane: \`git fetch origin <branch>\` then \`git merge --no-edit FETCH_HEAD\`, then push \`HEAD:refs/heads/<branch>\`.
- Stop background jobs with the job tool (TaskStop or \`kill <exact pid>\`), never \`pkill\`/\`killall\`.`;
export const NO_PROMPT_COMMAND_RULES = `${NO_PROMPT_COMMAND_RULES_SENTINEL}\n${NO_PROMPT_COMMAND_RULES_BODY}\n${NO_PROMPT_COMMAND_RULES_END}`;
export const NO_GIT_COMMAND_RULES_SENTINEL = '<!-- no-prompt-command-rules:no-git:begin -->';
export const NO_GIT_COMMAND_RULES_END = '<!-- no-prompt-command-rules:no-git:end -->';
export const NO_GIT_COMMAND_RULES_BODY = NO_PROMPT_COMMAND_RULES_BODY.split('\n').filter(line => !line.startsWith('- Never `git ')).join('\n');
export const NO_GIT_COMMAND_RULES = `${NO_GIT_COMMAND_RULES_SENTINEL}\n${NO_GIT_COMMAND_RULES_BODY}\n${NO_GIT_COMMAND_RULES_END}`;
const COMMAND_RULE_VARIANTS = [NO_PROMPT_COMMAND_RULES, NO_GIT_COMMAND_RULES];

/** Locate complete canonical blocks by their own-line sentinel in instruction position.
 * Track data tags, Markdown fences/spans, and HTML comments; none can donate a trusted sentinel.
 * Incomplete or mismatched fences retain an open scope, requiring a prefix on rendering.
 */
export function noPromptRulePlacement(brief) {
  const blocks = [];
  const tags = [];
  let markdown = null, inline = 0, comment = false, malformed = false, offset = 0;
  while (offset < brief.length) {
    const newline = brief.indexOf('\n', offset);
    const end = newline < 0 ? brief.length : newline;
    const line = brief.slice(offset, end).replace(/\r$/, '');
    const rules = COMMAND_RULE_VARIANTS.find(block => line === block.split('\n')[0] && brief.startsWith(block, offset));
    if (!markdown && !inline && !comment && !tags.length && !malformed
      && rules) {
      const blockEnd = offset + rules.length;
      if (blockEnd === brief.length || brief[blockEnd] === '\n' || brief.slice(blockEnd, blockEnd + 2) === '\r\n') {
        blocks.push({ start: offset, end: blockEnd });
        offset = blockEnd;
        if (brief[offset] === '\r') offset++;
        if (brief[offset] === '\n') offset++;
        continue;
      }
    }
    const fence = !inline && !comment && line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (markdown) {
      if (fence && fence[1][0] === markdown.char && fence[1].length >= markdown.length && !fence[2].trim()) markdown = null;
    } else if (fence) {
      markdown = { char: fence[1][0], length: fence[1].length };
    } else {
      let at = 0;
      while (at < line.length) {
        if (comment) {
          const close = line.indexOf('-->', at);
          const nested = line.indexOf('<!--', at);
          if (nested >= 0 && (close < 0 || nested < close)) malformed = true;
          if (close < 0) break;
          comment = false;
          at = close + 3;
          continue;
        }
        if (line[at] === '`') {
          let next = at + 1;
          while (line[next] === '`') next++;
          const length = next - at;
          // An unmatched backtick is literal Markdown, not an open code span.
          const remaining = COMMAND_RULE_VARIANTS.reduce((text, block) => text.replaceAll(block, ''), brief.slice(offset + next));
          const closes = remaining.match(/`+/g)?.some(run => run.length === length);
          if (!inline && closes) inline = length;
          else if (inline === length) inline = 0;
          at = next;
          continue;
        }
        if (inline) { at++; continue; }
        if (line.startsWith('<!--', at)) { comment = true; at += 4; continue; }
        const tag = line[at] === '<' && line.slice(at).match(/^<\s*(\/?)\s*([A-Za-z][\w:-]*)(?:\s[^<>]*?)?\s*(\/?)>/);
        if (tag) {
          const name = tag[2].toLowerCase();
          // Runtime placeholders such as <branch> are prose, not labelled data fences.
          const dataTag = /^(task|concerns|approach|findings|goal|material)$/.test(name)
            || brief.slice(offset + at + tag[0].length).includes(`</${name}>`);
          if (!dataTag && !tags.includes(name)) { at += tag[0].length; continue; }
          if (tag[1]) {
            if (tags.at(-1) === name) tags.pop();
            else malformed = true;
          } else if (!tag[3]) tags.push(name);
          at += tag[0].length;
          continue;
        }
        at++;
      }
    }
    offset = newline < 0 ? brief.length : end + 1;
  }
  return { blocks, closed: !markdown && !inline && !comment && !tags.length && !malformed };
}

/** Remove only complete, trusted sentinel blocks, leaving quoted data and other instructions intact. */
export function stripTrustedNoPromptCommandRules(brief) {
  const { blocks } = noPromptRulePlacement(brief);
  let result = brief;
  for (const { start, end } of blocks.reverse()) result = result.slice(0, start) + result.slice(end);
  return result;
}

/** Refuse missing task content before adding context, policy, or command rules. */
export function assertBriefTaskContent(brief) {
  if (typeof brief !== 'string') throw new TypeError('no-prompt rules require a string brief');
  const task = brief.replaceAll(NO_PROMPT_COMMAND_RULES, '')
    .replaceAll(NO_GIT_COMMAND_RULES, '')
    .replaceAll(NO_PROMPT_COMMAND_RULES_BODY, '')
    .replaceAll(NO_GIT_COMMAND_RULES_BODY, '')
    .replaceAll(NO_PROMPT_COMMAND_RULES_GENERATED_COMMENT, '')
    .replaceAll(NO_PROMPT_COMMAND_RULES_SENTINEL, '')
    .replaceAll(NO_PROMPT_COMMAND_RULES_END, '')
    .replaceAll(NO_GIT_COMMAND_RULES_SENTINEL, '')
    .replaceAll(NO_GIT_COMMAND_RULES_END, '');
  if (!task.trim()) {
    throw new Error('empty task content — refusing a brief containing only whitespace or command rules');
  }
  return brief;
}

/** Reuse only a trusted sentinel block. Prefix when an unfinished fence makes appending unsafe. */
export function renderNoPromptCommandRules(brief, source) {
  assertBriefTaskContent(brief);
  const properties = typeof source === 'string' ? LAUNCH_BRIEF_PROPERTIES[source] : source;
  if (source !== undefined && (!properties || typeof properties.allowsGit !== 'boolean')) {
    throw new Error('no-prompt rules require a registered brief or an explicit allowsGit boolean');
  }
  const rules = properties?.allowsGit === false ? NO_GIT_COMMAND_RULES : NO_PROMPT_COMMAND_RULES;
  const placement = noPromptRulePlacement(brief);
  // An outer transport without a new declaration preserves the already-declared trusted variant.
  if (placement.blocks.length) {
    if (source === undefined) return brief;
    let result = brief;
    for (const [index, { start, end }] of Array.from(placement.blocks.entries()).reverse()) {
      result = result.slice(0, start) + (index === 0 ? rules : '') + result.slice(end);
    }
    return result;
  }
  return placement.closed ? `${brief}\n\n${rules}\n` : `${rules}\n\n${brief}`;
}

/** Generated import-free runtime for the workflow sandbox; pinned against this source by the tree test. */
export function renderNoPromptCommandRulesRuntime() {
  return [
    `const NO_PROMPT_COMMAND_RULES = ${JSON.stringify(NO_PROMPT_COMMAND_RULES)};`,
    `const NO_PROMPT_COMMAND_RULES_BODY = ${JSON.stringify(NO_PROMPT_COMMAND_RULES_BODY)};`,
    `const NO_PROMPT_COMMAND_RULES_SENTINEL = ${JSON.stringify(NO_PROMPT_COMMAND_RULES_SENTINEL)};`,
    `const NO_PROMPT_COMMAND_RULES_END = ${JSON.stringify(NO_PROMPT_COMMAND_RULES_END)};`,
    `const NO_PROMPT_COMMAND_RULES_GENERATED_COMMENT = ${JSON.stringify(NO_PROMPT_COMMAND_RULES_GENERATED_COMMENT)};`,
    ...Object.entries({ NO_GIT_COMMAND_RULES, NO_GIT_COMMAND_RULES_BODY, NO_GIT_COMMAND_RULES_SENTINEL,
      NO_GIT_COMMAND_RULES_END, COMMAND_RULE_VARIANTS, LAUNCH_BRIEF_PROPERTIES }).map(([name, value]) => `const ${name} = ${JSON.stringify(value)};`),
    noPromptRulePlacement.toString(), stripTrustedNoPromptCommandRules.toString(),
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

/** Declared launch capabilities; role keys cover files that build both tool-bearing and tool-free briefs. */
export const LAUNCH_BRIEF_PROPERTIES = Object.freeze({
  ...Object.fromEntries(LAUNCH_BRIEF_SOURCES.map(source => [source, Object.freeze({ allowsGit: true })])),
  ...Object.fromEntries([
    'scripts/conveyor/stuck-pr-inspect-dispatch.mjs',
    'scripts/conveyor/health-investigate-dispatch.mjs',
    'skills-src/conveyor/stuck-pr-inspect-brief.md',
    'skills-src/conveyor/stuck-pr-inspect-system-prompt.md',
    'skills-src/conveyor/health-investigate-brief.md',
    'skills-src/conveyor/opus-sweep-brief.md',
    'scripts/operations/coroner-judge.mjs',
    'scripts/operations/coroner-sample.mjs',
    'scripts/operations/explore.mjs',
    'scripts/operations/explore-io.mjs',
    'scripts/operations/perf-velocity-io.mjs',
    'scripts/operations/record-referral-ruling-io.mjs',
    'scripts/operations/review-extra-seats.mjs',
    'scripts/lib/brief-red-team.mjs',
    'scripts/lib/decision-prose-adapter.mjs',
    'skills-src/jury/panel-fanout.mjs',
    'scripts/conveyor/convert-advisory-dispatch.mjs',
    'scripts/probes/worker-result-probe.mjs',
    'scripts/lib/judge-spawn.mjs#tool-free',
    'scripts/lib/review-core.mjs#plan',
    'scripts/lib/build-self-review.mjs#review',
  ].map(source => [source, Object.freeze({ allowsGit: false })])),
});

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
