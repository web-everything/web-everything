/** Shared command discipline for sessions running under the operator's Claude permissions.
 * Markdown briefs and sandbox workflows also carry generated copies of this block.
 */
const NO_PROMPT_COMMAND_RULES_SENTINEL = '<!-- no-prompt-command-rules:begin -->';
const NO_PROMPT_COMMAND_RULES_END = '<!-- no-prompt-command-rules:end -->';
const NO_PROMPT_COMMAND_RULES_BODY = `## No-prompt command rules

- Plain single commands only: no \`$(...)\`, no shell variables or arrays, no loops, no trailing \`&\`.
- Edit files with the Edit/Write tools, never \`sed -i\`, \`perl -i\`, or redirect writes.
- Never \`rm -rf\` / \`rm -r\`: write scratch to a NEW uniquely named dir instead of deleting.
- Never run destructive history or working-tree resets, forced pushes, or cleans.
- Stop background jobs with the job tool (TaskStop), never \`pkill\`/\`killall\`.`;
export const NO_PROMPT_COMMAND_RULES = `${NO_PROMPT_COMMAND_RULES_SENTINEL}\n${NO_PROMPT_COMMAND_RULES_BODY}\n${NO_PROMPT_COMMAND_RULES_END}`;

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
