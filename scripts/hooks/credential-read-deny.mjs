#!/usr/bin/env node
/** R1082 standalone PreToolUse guard. Deliberately separate from operator-owned
 * ~/.plateau/hooks/allow-compound.mjs; ordering independent: any PreToolUse deny wins.
 * Bootstrap copies this hook plus its matcher and resolved policy beside it.
 * Unparseable input is silent; matching reads never fail open. Oversized input asks
 * the operator to inspect the full request rather than approving incomplete evidence.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classifyBashCommand, classifyProtectedPath, readCredentialProtection } from '../lib/credential-protection.mjs';

const isAgent = (input, env) => Boolean(input?.agent_id || input?.agent_type
  || env.WE_CONVEYOR_WORKER === '1' || env.WE_DISPATCH_KIND);

export function credentialHook(input, { env = process.env, home = homedir(), repoRoot = input?.cwd || process.cwd(), policy } = {}) {
  const agent = isAgent(input, env);
  const tool = input?.tool_name;
  const options = { home, repoRoot, ...(policy ? { protectedPaths: policy.protectedPaths } : {}) };
  const hit = tool === 'Bash' ? classifyBashCommand(input.tool_input?.command, options)
    : ['Read', 'Edit', 'Write', 'NotebookEdit'].includes(tool)
      ? classifyProtectedPath(input.tool_input?.file_path ?? input.tool_input?.notebook_path, options) : { decision: 'pass' };
  if (hit.decision !== 'deny') return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: agent ? 'deny' : 'ask',
    permissionDecisionReason: `Protected credential path ${hit.path}: ${hit.reason}` } };
}
export function main() {
  let raw, input;
  try { raw = readFileSync(0, 'utf8'); input = JSON.parse(raw); } catch {
    // Malformed JSON cannot erase an observable match. Identity is unknown, so deny.
    const hit = classifyBashCommand(raw, { home: homedir(), repoRoot: process.cwd() });
    if (hit.decision === 'deny') process.stdout.write(`${JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: `Malformed hook input references ${hit.path}: ${hit.reason}; repair input before retrying.`,
    } })}\n`);
    return;
  }
  let policy;
  try { policy = readCredentialProtection(readFileSync(new URL('./credential-protection.json', import.meta.url), 'utf8')); }
  catch { policy = readCredentialProtection(''); }
  let output;
  try {
    output = raw.length > 1024 * 1024 ? { hookSpecificOutput: { hookEventName: 'PreToolUse',
      permissionDecision: isAgent(input, process.env) ? 'deny' : 'ask',
      permissionDecisionReason: 'Credential check input exceeds 1 MiB; operator must inspect the full request.' } }
      : credentialHook(input, { policy });
  } catch {
    // Valid tool input that could not be classified is incomplete evidence, never a silent approval.
    output = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: 'Credential check failed; operator must inspect this request and repair the hook.' } };
  }
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
}
// Compare real paths: a symlinked hooks dir (macOS /var -> /private/var) must still run main, never go silent.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return pathToFileURL(realpathSync(resolve(process.argv[1]))).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href; }
  catch { return pathToFileURL(resolve(process.argv[1])).href === import.meta.url; }
}
if (invokedDirectly()) main();
