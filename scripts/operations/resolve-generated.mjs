/** Regenerate conflicted generated documents from staged inputs; leave merge/rebase continuation to the worker. */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { op } from './registry.mjs';
import { effect } from './step-kinds.mjs';
import { GENERATED_MERGE_PATHS, resolveAdvisoryInWorktree } from '../lib/daemon-rebuild/advisory-merge.mjs';
import { makeGit } from '../lib/daemon-rebuild/shared.mjs';

export const RESOLVE_GENERATED_OP = 'resolve-generated';
export const RESOLVE_GENERATED_EFFECT = 'generated.resolve';
export function resolveGenerated({ cwd = process.cwd(), git } = {}) {
  try {
    cwd = resolve(cwd);
    git ??= makeGit({ cwd, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
      run: (args, options) => spawnSync('git', args, { ...options, encoding: 'utf8', maxBuffer: 1024 * 1024 }) });
    const unmerged = git(['diff', '--name-only', '-z', '--diff-filter=U']);
    if (unmerged.status !== 0) return false;
    const paths = String(unmerged.stdout ?? '').split('\0').filter(Boolean);
    if (!paths.length || paths.some(path => !Object.hasOwn(GENERATED_MERGE_PATHS, path))) return false;
    return resolveAdvisoryInWorktree({ git, cwd, commit: false });
  } catch { return false; }
}
export function resolveGeneratedOperation() {
  return op(RESOLVE_GENERATED_OP, {
    input: { cwd: { type: 'string', required: false, default: '.' } },
    resolve: effect({ reads: ['input.cwd'], effects: ({ input }) => [{ type: RESOLVE_GENERATED_EFFECT, payload: input }] }),
  });
}
export function finishResolveGenerated({ run, code, lines }) {
  const applied = run?.effects?.find(entry => entry.type === RESOLVE_GENERATED_EFFECT && entry.status === 'applied');
  if (code !== 0) return { code, lines };
  return applied?.result === true ? { code: 0, lines: ['Generated conflicts resolved and staged; continue the merge or rebase.'] }
    : { code: 1, lines: ['Generated resolution refused; inspect unmerged paths and generator inputs, then resolve manually.'] };
}
