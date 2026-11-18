/** Shared command discipline for sessions running under the operator's Claude permissions.
 * Only the session kinds observed prompting the operator opt in; other sessions retain their own briefs.
 */
/** Explicit scope: fixer, CI-heal, review-job and red-team sessions only. */
export const NO_PROMPT_SESSION_KINDS = Object.freeze(['fix', 'ci-heal', 'review-job', 'red-team']);

const NO_PROMPT_COMMAND_RULES_SENTINEL = '<!-- no-prompt-command-rules:begin -->';
const NO_PROMPT_COMMAND_RULES_END = '<!-- no-prompt-command-rules:end -->';
const NO_PROMPT_COMMAND_RULES_BODY = `## No-prompt command rules

- No \`for\`/\`while\` loops in one command; split them into separate commands.
- No trailing \`&\` (use the tool's background option).
- No \`sed -i\` / \`perl -i\` (use the Edit tool).
- \`rm -rf\` only on plain scratch names in the current lane; never \`rm -r\` on anything else.
- Never \`pkill\`, \`killall\` or \`kill -9\` (use TaskStop or \`kill <pid>\`).
- Never \`git reset --hard\`, \`git push --force\` or \`git clean\`.`;
export const NO_PROMPT_COMMAND_RULES = `${NO_PROMPT_COMMAND_RULES_SENTINEL}\n${NO_PROMPT_COMMAND_RULES_BODY}\n${NO_PROMPT_COMMAND_RULES_END}`;

/** Validate the task itself before the builder adds any instructions. */
export function assertBriefTaskContent(task) {
  if (typeof task !== 'string') throw new TypeError('no-prompt rules require a string brief');
  if (!task.trim()) throw new Error('empty task content — refusing an empty or whitespace-only task');
  return task;
}

/** R115: the builder owns this fixed header; task text never controls its inclusion. */
export function renderNoPromptCommandRules(task, sessionKind) {
  if (!NO_PROMPT_SESSION_KINDS.includes(sessionKind)) return task;
  assertBriefTaskContent(task);
  return `${NO_PROMPT_COMMAND_RULES}\n\n${task}`;
}
