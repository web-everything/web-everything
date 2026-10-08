#!/usr/bin/env node
/**
 * @file scripts/lib/dispatch-smoke-launch.mjs
 * @description The launch harness of the overlay dispatch smoke (xkhtg2a). It runs INSIDE the tree under test (its
 *   own modules, its own launch path) and makes the same request `createDispatchSinks` hands `defaultClaudeProvider`
 *   for a ci-heal/fix dispatch. Prints `{handle, wrapperPid, cwd}` as its last line.
 *
 *   argv: <tree> <slug> <kind> <pr> <sessionId> <prompt>
 *
 * It is spawned as a process by `we:scripts/lib/daemon-load-overlay.mjs#runRealDispatchSmoke` and NEVER imported:
 * it loads modules from a computed path, and a computed `import(...)` in a file the review code path reaches makes
 * `we:scripts/lib/import-closure.mjs` report that closure incomplete, which fails closed and puts EVERY code file
 * on the review/promote code path (live: PR #4488 — it reddened review-dispatch, review-job, promote-draft-pr-dispatch,
 * daemon-live-smoke and two soak breaks). Keep this file out of every static import.
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [tree, slug, kind, pr, sessionId, prompt] = process.argv.slice(2);
const imp = (p) => import(pathToFileURL(join(tree, p)).href);
const io = await imp('scripts/operations/dispatch-lane-io.mjs');
const iso = await imp('scripts/lib/dispatch-bg-isolation.mjs');
const cwd = io.ensureDispatchSessionCwd(io.dispatchSessionCwd(sessionId, { root: tree }));
const isolated = iso.isolateDispatchSession(cwd);
const resolveEnv = io.resolveDispatchSettingsEnv || io.resolveGhShimSettingsEnv;
let wrapperPid = null;
const handle = io.defaultClaudeProvider({
  sessionId, cwd, prompt, sessionSlug: slug, launchKind: kind, pr,
  systemPromptFile: io.DISPATCHED_AGENT_SYSTEM_PROMPT_FILE, settingsEnv: resolveEnv(cwd),
  worktreeSettings: (isolated && isolated.worktreeSettings) || null,
  reportWrapped: (pid) => { wrapperPid = pid; },
});
process.stdout.write('\n' + JSON.stringify({ handle, wrapperPid, cwd }) + '\n');
