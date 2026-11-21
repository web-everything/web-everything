#!/usr/bin/env node
/**
 * sync-commands-deploy.mjs — deploy `.claude/commands/` to the machine-global `~/.claude/commands`.
 *
 * THE GAP THIS CLOSES. Skills and agent-memory each have a source of truth OUTSIDE `.claude/`
 * (`skills-src/`, `agent-memory-src/`) with `.claude/` symlinking in, so the repo-local copy cannot drift,
 * and `sync-skills-deploy.mjs` (#2579) carries the repo-local copy out to the user's machine-global tree.
 * Slash commands got neither: `.claude/commands/*.md` are plain tracked files with no deploy path, so they
 * are live only in a session whose PRIMARY directory is this repo. From a sibling repo, a lane, or any
 * cloud VM, twenty commands silently do not exist.
 *
 * WHY NOT SYMLINK THEM, THE WAY SKILLS ARE SYMLINKED. The symlink in `.claude/skills` points INWARD (repo →
 * repo) and is safe. Pointing the machine-global tree at the repo is a different thing, and this repo has
 * already paid for it: see the notes above `assertInsideRoot` in sync-skills-deploy.mjs, where a symlinked
 * intermediate under the deploy root let writes escape it entirely, a `destDir` that was itself a symlink
 * made the containment check a tautology that overwrote `skills-src/` itself, and a 2-node symlink cycle
 * ELOOP-hung the post-merge hook, wedging `git pull`. Beyond the bugs, `~/.claude/commands` is the
 * OPERATOR's directory: it may hold their own commands, and a symlinked directory cannot hold both. Copying
 * keeps the user's tree theirs — additive by default, deletion opt-in, drift reported.
 *
 * REUSE, NOT A SECOND IMPLEMENTATION. Every risky part — containment, the opt-in prune, the tracked-files-
 * only rule, the drift report — is imported from sync-skills-deploy.mjs. The only thing this file adds is
 * the shape difference: skills are a directory per unit, commands are FLAT `.md` files, so this deploys one
 * unit whose tracked files happen to sit at depth 1.
 *
 * Usage:
 *   node scripts/sync-commands-deploy.mjs            # sync when ~/.claude/commands already exists
 *   node scripts/sync-commands-deploy.mjs --all       # deploy even if the operator has no commands tree yet
 *   node scripts/sync-commands-deploy.mjs --check     # report drift only, write nothing; exit 1 if any
 *   node scripts/sync-commands-deploy.mjs --dry-run   # print planned actions, write nothing; exit 0
 *   node scripts/sync-commands-deploy.mjs --prune     # ALSO delete deploy-root files no longer tracked
 *
 * WE_COMMANDS_DEPLOY_DIR overrides the deploy root (tests / a non-default machine layout).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeLineSync } from './lib/write-all-sync.mjs';
import { applyPlan, formatPlans, gitTrackedFiles, parseArgs, planSkill } from './sync-skills-deploy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');
export const SRC_ROOT = path.join(REPO_ROOT, '.claude', 'commands');

/** The machine-global commands tree. Mirrors sync-skills-deploy's `deployRoot`, one directory over. */
export function deployRoot(env = process.env) {
  return env.WE_COMMANDS_DEPLOY_DIR
    ? path.resolve(env.WE_COMMANDS_DEPLOY_DIR)
    : path.join(os.homedir(), '.claude', 'commands');
}

/**
 * The single deploy plan for the commands tree.
 *
 * `destRoot === destDir` here, unlike the skills case, and deliberately: commands have no per-unit
 * subdirectory, so the deploy root IS the unit's directory. The containment check therefore anchors on the
 * operator's real `~/.claude/commands` — not on a per-unit path that could itself be a symlink, which is the
 * tautology the skills deploy had to fix.
 */
export function buildCommandsPlan({ srcRoot = SRC_ROOT, destRoot, all = false, prune = false, repoRoot = REPO_ROOT, exists = fs.existsSync } = {}) {
  if (!exists(srcRoot)) throw new Error(`sync-commands-deploy: missing commands at ${srcRoot}`);
  // Default is conservative in the same way the skills deploy is: do not CREATE a machine-global commands
  // tree on a machine that has chosen not to have one. `--all` is the deliberate bootstrap.
  if (!all && !exists(destRoot)) return null;
  const trackedRel = gitTrackedFiles(srcRoot, repoRoot);
  return planSkill({ name: 'commands', srcDir: srcRoot, destDir: destRoot, trackedRel, prune, destRoot });
}

function main(argv) {
  // parseArgs is shared with the skills deploy, which also accepts `--only=<names>`; there are no named
  // units here, so accepting it silently would be a flag that does nothing. Reject it explicitly.
  if (argv.some((a) => a.startsWith('--only='))) throw new Error('sync-commands-deploy: --only is meaningless here (commands deploy as one unit)');
  const { check: checkOnly, dryRun, prune, all, roots } = parseArgs(argv);
  if (roots.length) throw new Error('sync-commands-deploy: --root is not supported (single source root)');
  const destRoot = deployRoot();
  const plan = buildCommandsPlan({ destRoot, all, prune });

  if (!plan) {
    writeLineSync(1, `no commands tree at ${destRoot} — pass --all to deploy one`);
    return 0;
  }
  if (!checkOnly && !dryRun) applyPlan(plan);
  writeLineSync(1, formatPlans([plan], { checkOnly, dryRun, noun: 'command' }));
  const drifted = plan.actions.length > 0 || plan.stale.length > 0;
  return checkOnly && drifted ? 1 : 0;
}

// `process.exitCode =`, not `process.exit()` — #3061's exit-wraps-call shape discards the callee's flush.
// A usage error is a one-line message on stderr, not a stack trace: this runs from a git hook and from the
// bootstrap, where a Node traceback buries the one sentence the operator needs.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    writeLineSync(2, `Error: ${e.message}`);
    process.exitCode = 2;
  }
}
