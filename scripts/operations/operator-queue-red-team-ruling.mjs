/**
 * @file scripts/operations/operator-queue-red-team-ruling.mjs
 * @description The operator-queue's command suggestions for a red-team round-cap ruling. They replace the queue's
 *   old `block`/`notReal` pair, whose not-real was `review-set-label --to=clear-human` (approves the WHOLE PR).
 *   `operator-queue.mjs` was held by other PRs when `record-red-team-ruling` landed, so its `redTeamRulingRow` takes
 *   these with one line: `commands: redTeamRulingCommands(repo, pr.number)`. PURE.
 */
const base = (repo, pr, ruling) => `node scripts/operations/run.mjs record-red-team-ruling --pr=${pr} --repo=${repo} `
  + `--break=<#n or file:line> --ruling=${ruling} --actor=<your login> --channel='<where you ruled>' --reason='<your words>'`;

/** The three `record-red-team-ruling` commands for one PR (same key names the queue row already uses). PURE. */
export function redTeamRulingCommands(repo, pr) {
  return { card: base(repo, pr, 'card'), block: base(repo, pr, 'block'), notReal: base(repo, pr, 'not-real') };
}
