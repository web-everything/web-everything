#!/usr/bin/env node
/**
 * @file scripts/operations/record-red-team-ruling-cli.mjs
 * @description Standalone entry for the declared `record-red-team-ruling` operation, same engine and flags as
 *   `run.mjs record-red-team-ruling`. It exists because `run.mjs` was held by other PRs when the operation landed;
 *   once the one-line `OPERATIONS` entry is added there (`[RECORD_RED_TEAM_RULING_OP]: recordRedTeamRulingEntry`)
 *   this file is only a convenience.
 *     node scripts/operations/record-red-team-ruling-cli.mjs --pr=<n> --repo=<o/r> --break=<#n|file:line> \
 *       --ruling=card --card=<we:backlog/ref.md> --actor=<login> --channel='<where>' --reason='<operator words>' [--preview]
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegistry } from './registry.mjs';
import { createFileRunStore, createMemoryRunStore, newRunId } from './run-store.mjs';
import { createFileCallLogStore } from './call-log-store.mjs';
import { runOperationCli, buildCliSpec } from './cli-adapter.mjs';
import { writeAllSync } from '../lib/write-all-sync.mjs';
import { recordRedTeamRulingEntry } from './record-red-team-ruling-io.mjs';

export async function main(argv, { entry = recordRedTeamRulingEntry, stores } = {}) {
  const { declaration, sinks } = entry();
  if (argv.includes('--help')) { writeAllSync(1, `${buildCliSpec(declaration).usage}\n`); return 0; }
  const registry = createRegistry();
  registry.register(declaration);
  const preview = argv.includes('--preview');
  const outcome = await runOperationCli({
    declaration, argv, registry, sinks,
    store: stores?.store ?? (preview ? createMemoryRunStore() : createFileRunStore()),
    callLog: stores ? stores.callLog : preview ? undefined : createFileCallLogStore(),
    makeJudge: () => null, // no judge is used; runOperationCli builds one eagerly after the parse
    newRunId: () => newRunId(declaration.name),
  });
  writeAllSync(1, `${outcome.lines.join('\n')}\n`);
  return outcome.code;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { writeAllSync(1, `error: ${String(e?.message ?? e)}\n`); process.exit(1); });
}
