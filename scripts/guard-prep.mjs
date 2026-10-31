#!/usr/bin/env node
/** PreToolUse(Agent|Task) prep gate. Decisions are pure; the stdin boundary fails OPEN. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isPrepExempt, logPrepEvent, prepVerdict } from './lib/prep-block.mjs';

function applies(event) {
  const type = event?.tool_input?.subagent_type;
  const normalized = typeof type === 'string' ? type.trim().toLowerCase() : '';
  const prompt = event?.tool_input?.prompt;
  return event?.hook_event_name === 'PreToolUse' && ['Agent', 'Task'].includes(event.tool_name)
    && ['', 'codex-runner', 'worker', 'general-purpose'].includes(normalized)
    && typeof prompt === 'string' && /\b(build|implement|add|fix|refactor|write)\b/i.test(prompt)
    && /\b(open-pr|push|pull request|PR)\b/i.test(prompt) && !isPrepExempt(prompt);
}

export function decide(event) {
  if (!applies(event)) return null;
  const verdict = prepVerdict(event.tool_input.prompt);
  return verdict.ok ? null : { hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.reason,
  } };
}

/** Injectable boundary also exercises exception handling without an environment bypass switch. */
export function runHook({ read = () => readFileSync(0, 'utf8'), decide: decision = decide,
  stdout = (text) => process.stdout.write(text), stderr = (text) => process.stderr.write(text), logPath } = {}) {
  try {
    const event = JSON.parse(read());
    const result = decision(event);
    if (result) stdout(JSON.stringify(result));
    else if (applies(event)) {
      const verdict = prepVerdict(event.tool_input.prompt);
      if (verdict.waived) logPrepEvent({ kind: 'waiver', detail: verdict.reason }, { logPath });
    }
  } catch (error) {
    const detail = String(error?.message || error).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
    logPrepEvent({ kind: 'hook-error', detail }, { logPath });
    try { stderr(`guard-prep: WARNING — failing open: ${detail}\n`); } catch { /* fail open */ }
  }
}

const IS_CLI = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (IS_CLI) runHook();
