/** Scoring evidence uses Git's built-in diff against an empty attribute tree.
 * Pure command construction, injectable execFileSync-shaped IO. Errors propagate:
 * callers must invalidate the complete score, never substitute empty evidence.
 * --attr-source also makes Git versions without attribute-source support refuse.
 */
export const EMPTY_ATTRIBUTE_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function hardenedGitDiffCommand(args, opts = {}, env = {}) {
  const protectedEnv = {
    ...env, ...opts.env,
    GIT_NO_REPLACE_OBJECTS: '1', GIT_ATTR_NOSYSTEM: '1', GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_SOURCE: EMPTY_ATTRIBUTE_TREE,
  };
  delete protectedEnv.GIT_EXTERNAL_DIFF;
  return {
    args: ['--attr-source=' + EMPTY_ATTRIBUTE_TREE,
      '-c', 'core.attributesFile=/dev/null', '-c', 'diff.external=',
      ...args.slice(0, 1), '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color',
      ...args.slice(1)],
    opts: { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120e3, maxBuffer: 64 * 1024 * 1024, ...opts, env: protectedEnv },
  };
}

export function hardenedGitDiff(exec, args, opts) {
  const command = hardenedGitDiffCommand(args, opts, process.env);
  return exec('git', command.args, command.opts);
}
