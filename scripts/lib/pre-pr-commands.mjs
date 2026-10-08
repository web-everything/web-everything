/**
 * @file scripts/lib/pre-pr-commands.mjs
 * @description Pure (no imports): the exact commands that produce a pre-PR review receipt. Split out of
 *   pre-pr-review.mjs so the read-only `pre-pr-check` operation can print them without importing a module that
 *   can write files.
 */

/** One shell word: left bare when it is plainly safe, else single-quoted. */
export const shellWord = (s) => (/^[\w@%+=:,./~-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

/**
 * The exact commands that produce a pre-PR review receipt for `lane` (an absolute lane root; the literal `<lane>`
 * when unknown). One source for the `pre-pr-check` helper and the open-pr advise/refuse message; the briefs spell
 * the same commands in prose, and their test pins the key pieces. `loop` is the part no script can run for you:
 * drive init/step to `land` via the /converge skill.
 * @returns {{state: string, init: string, loop: string, commit: string, receipt: string, text: string}}
 */
export function prePrReviewCommands(lane = '<lane>') {
  const placeholder = lane === '<lane>';
  const state = `${lane.replace(/\/+$/, '')}/.converge-state.json`;
  const [q, qs] = placeholder ? [lane, state] : [shellWord(lane), shellWord(state)];
  const init = `node scripts/converge-cli.mjs init --lane=${q} --state=${qs} --care=elevated --goal="<one sentence: what this work does>"`;
  const loop = 'drive `step` to `land` per skills-src/converge/SKILL.md (the /converge skill), fixing findings in the lane';
  const commit = 'commit the fixes (the receipt needs a clean tracked tree)';
  const receipt = `node scripts/converge-cli.mjs receipt --lane=${q} --state=${qs}`;
  return { state, init, loop, commit, receipt, text: `1) ${init}  2) ${loop}  3) ${commit}  4) ${receipt}` };
}
