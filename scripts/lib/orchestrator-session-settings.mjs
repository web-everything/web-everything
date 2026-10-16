/** Opt-in responsiveness policy for the operator-facing session. */
import { resolveCascade, platformPreference, logCascadeSources } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';
import { classifySession } from '../operations/session-role.mjs';

export const ORCHESTRATOR_DELEGATE_COMMANDS = Object.freeze([
  'node scripts/operations/run.mjs verify',
  'node scripts/operations/run.mjs verify-lane',
  'node scripts/verify-lane.mjs',
  'node scripts/operations/run.mjs open-pr',
  'node scripts/readiness/heavy-admission.mjs run',
  'npx vitest',
  'npm run check:standards',
  'npm run test:unit',
  'node scripts/daemon-rebuild.mjs',
  'node scripts/daemon-load-overlay.mjs',
  'node scripts/daemon-overlay.mjs add',
  'node scripts/codex-direct-task.mjs',
  'node scripts/gemini-direct-task.mjs',
]);

export function loadOrchestratorSessionSettings({ env = process.env, tool = readSettings().session,
  platform, agentSession = false, log } = {}) {
  const flag = env.WE_ORCHESTRATOR_SESSION;
  const resolved = resolveCascade({
    tool, platform: platform === undefined ? platformPreference('session', { env }) : platform,
    standard: { orchestratorMode: false, orchestratorDelegateCommands: ORCHESTRATOR_DELEGATE_COMMANDS },
    envValues: { orchestratorMode: flag === undefined ? undefined
      : flag === '1' || flag === 'true' ? true : flag === '0' || flag === 'false' ? false : flag },
    valid: { orchestratorMode: v => typeof v === 'boolean',
      orchestratorDelegateCommands: v => Array.isArray(v) && v.every(c => typeof c === 'string' && c.trim().length > 0) },
  });
  // Hook subagents share the parent's session id and may inherit its env/settings.
  // Neither that inheritance nor an explicit opt-in can turn a worker into an orchestrator.
  if (agentSession || env.WE_DISPATCH_KIND || classifySession(env).role !== 'orchestrator') {
    resolved.value.orchestratorMode = false;
    resolved.sources.orchestratorMode = 'worker/subagent';
    resolved.leafValues.orchestratorMode = false;
  }
  // Log only the final effective policy, using the shared opt-in/daemon logging rules.
  logCascadeSources('session', resolved, { env, ...(log ? { log } : {}) });
  return resolved;
}
