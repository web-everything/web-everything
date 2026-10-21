/**
 * @file scripts/operations/operator-queue-red-team-ruling.mjs
 * @description The operator-queue's read-only command suggestions for a red-team round-cap ruling. They live in their
 *   own module because `operator-queue.mjs` was held by other PRs when `record-red-team-ruling` landed; the queue's
 *   `redTeamRulingRow` adds them with `commands: { ...redTeamRulingCommands(repo, pr.number), block, notReal }`.
 *   PURE.
 */
const base = (repo, pr, ruling) => `node scripts/operations/run.mjs record-red-team-ruling --pr=${pr} --repo=${repo} `
  + `--break=<#n or file:line> --ruling=${ruling} --actor=<your login> --channel='<where you ruled>' --reason='<your words>'`;

/** The three `record-red-team-ruling` commands for one PR. PURE. */
export function redTeamRulingCommands(repo, pr) {
  return { card: base(repo, pr, 'card'), blockRuling: base(repo, pr, 'block'), notRealRuling: base(repo, pr, 'not-real') };
}
