#!/usr/bin/env node
/** @file /state: one read-only answer about a PR or card, including the evidence and next event. */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readPrFacts, readCardFacts, stripTerminal } from './lib/pr-state-io.mjs';
import { derivePrState, settingsFromEnv } from './lib/pr-state-core.mjs';
/** Every printed line passes the sanitizer, so no field (named or not) can carry a terminal escape or a CR. */
const line = text => stripTerminal(text);
export function renderPrState(state, subject) {
  return [line(`${state.phase} — ${subject}: ${state.headline}`), line(`Next: ${state.next}`),
    ...state.evidence.map(e => `  • ${line(e)}`)].join('\n');
}
export function renderCard(card) {
  const sessions = card.activeSessionsKnown === false ? 'unknown (claude agents unavailable)'
    : card.activeSessions.map(s => s.name).join(', ') || 'none observed';
  return [
    line(`CARD ${card.id} — ${card.status}${card.found ? '' : ' (not found or unreadable)'}`),
    line(`Claim: ${card.claim.held ? 'held' : 'none observed'}${card.claim.owner ? ` by ${card.claim.owner}` : ''}; active sessions: ${sessions}`),
    ...card.prs.map(p => renderPrState(p, `PR #${p.pr}`)), ...card.evidence.map(line),
  ].join('\n');
}
export function main(argv = process.argv.slice(2)) {
  const args = argv.filter(a => a !== '--json');
  if (args.length !== 1 || !/^(?:#?[1-9]\d*|(?:card[-:])?[a-z0-9][a-z0-9-]*)$/i.test(args[0]) || args[0].startsWith('--')) {
    console.error('Usage: node scripts/state.mjs <N | #N | card-id> [--json]');
    return 2;
  }
  const arg = args[0];
  try {
    if (/^#?\d+$/.test(arg)) {
      const facts = readPrFacts(Number(arg.replace('#', '')));
      const state = derivePrState(facts, settingsFromEnv(process.env));
      console.log(argv.includes('--json') ? JSON.stringify({ ...state, facts }, null, 2) : renderPrState(state, `PR #${facts.pr}`));
    } else {
      const card = readCardFacts(arg);
      console.log(argv.includes('--json') ? JSON.stringify(card, null, 2) : renderCard(card));
    }
  } catch {
    const state = { phase: 'NEEDS-OPERATOR', headline: 'state probes unavailable', next: 'retry the state command', evidence: ['No verdict inferred from an unreadable probe'] };
    console.log(argv.includes('--json') ? JSON.stringify(state) : renderPrState(state, arg));
  }
  return 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
