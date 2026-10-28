/** Shared reader context: unknown standing-ruling evidence never grants automatic rounds. */
import { readRedTeamProbes } from './red-team-gate.mjs';
import { standingRulingScope } from '../conveyor/standing-ruling-io.mjs';

export function buildRedTeamDispositionInputs({ repo, pr, head, comments, env = process.env,
  standingRuling, readGrantScope = standingRulingScope } = {}) {
  const statusLabels = readRedTeamProbes({ env }).value.statusLabels;
  let scope = standingRuling ?? null;
  let scopeUnreadable = false;
  if (standingRuling === undefined) {
    try { scope = readGrantScope({ repo, pr: { number: Number(pr), headRefOid: head, comments } }) ?? null; }
    catch { scope = null; scopeUnreadable = true; }
  }
  return { repo, pr, head, comments, env, standingRuling: scope, statusLabels,
    ...(scopeUnreadable ? { scopeUnreadable: true } : {}) };
}
