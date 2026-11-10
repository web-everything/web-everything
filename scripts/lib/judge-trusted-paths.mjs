/** Fixed account-home trust inputs. Environment overrides are deliberately ignored. */
import { userInfo } from 'node:os';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';

export const JUDGE_TRUSTED_ROOT = join(userInfo().homedir, 'workspace/.operations/coordination');
export const JUDGE_DISPATCH_DIR = join(JUDGE_TRUSTED_ROOT, 'judge-dispatch');
export const JUDGE_VERDICTS_DIR = join(JUDGE_TRUSTED_ROOT, 'judge-verdicts');
export const JUDGE_SWITCHES_PATH = join(JUDGE_TRUSTED_ROOT, 'judge-switches.json');
export const JUDGE_TRUSTED_PATHS = Object.freeze([JUDGE_DISPATCH_DIR, JUDGE_VERDICTS_DIR, JUDGE_SWITCHES_PATH]);

const shellQuote = value => `'${value.replace(/'/g, `'"'"'`)}'`;

/**
 * The hook's literal check is advisory; Seatbelt enforces the actual write boundary,
 * including interpreter-computed paths and symlink aliases. No environment overrides.
 * Other platforms refuse until an equivalent OS boundary has been exercised there.
 * `paths` is an injection seam for hermetic fixtures, never a hook input.
 */
export function isolateJudgeInputs(command, { platform = process.platform, paths = JUDGE_TRUSTED_PATHS } = {}) {
  if (platform !== 'darwin') return null;
  if (typeof command !== 'string' || !command || !Array.isArray(paths) || !paths.length
    || paths.some(file => typeof file !== 'string' || !isAbsolute(file) || /[\x00-\x1f\x7f]/.test(file))) {
    throw new TypeError('Trusted judge isolation requires a command and absolute protected paths');
  }
  const ancestors = new Set();
  for (const file of paths) {
    for (let parent = dirname(file); parent !== dirname(parent); parent = dirname(parent)) ancestors.add(parent);
  }
  const profile = '(version 1) (allow default) '
    + `(deny file-write* ${paths.map(file => `(subpath ${JSON.stringify(file)})`).join(' ')}) `
    + `(deny file-write-unlink ${[...ancestors].map(file => `(literal ${JSON.stringify(file)})`).join(' ')})`;
  // `exec` ensures a native sandbox failure never falls through to the original command.
  return `exec /usr/bin/sandbox-exec -p ${shellQuote(profile)} /bin/bash -c ${shellQuote(command)}`;
}

export function isJudgeTrustedPath(file, cwd = '.') {
  const target = resolve(cwd, file);
  return JUDGE_TRUSTED_PATHS.some(root => {
    const suffix = relative(root, target);
    // Protect ancestors too: removing the coordination folder deletes the inputs.
    const ancestor = relative(target, root);
    return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix))
      || ancestor === '' || (!ancestor.startsWith('..') && !isAbsolute(ancestor));
  });
}
