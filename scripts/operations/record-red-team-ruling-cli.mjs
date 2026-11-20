#!/usr/bin/env node
/**
 * @file scripts/operations/record-red-team-ruling-cli.mjs
 * @description Standalone entry for the declared `record-red-team-ruling` operation, same engine and flags as
 *   `run.mjs record-red-team-ruling`. It exists because `run.mjs` was held by other PRs when the operation landed;
 *   once the one-line `OPERATIONS` entry is added there (`[RECORD_RED_TEAM_RULING_OP]: recordRedTeamRulingEntry`)
 *   this file is only a convenience.
 *   For --actor=judge:r10, prepend ~/.claude/github-app-token/gh-shim.d/<id> to PATH (App gh shim).
 *   Judge card requires --preExisting='{"mainSha":"<current main tip, 40 hex>","probe":"<command>","mainResult":"<result>","prResult":"<same result>"}'.
 *     node scripts/operations/record-red-team-ruling-cli.mjs --pr=<n> --repo=<o/r> --break=<#n|file:line> \
 *       --ruling=card --card=<we:backlog/ref.md> --actor=<login> --channel='<where>' --reason='<operator words>' [--preview]
 */
import { delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegistry } from './registry.mjs';
import { createFileRunStore, createMemoryRunStore, newRunId } from './run-store.mjs';
import { createFileCallLogStore } from './call-log-store.mjs';
import { runOperationCli, buildCliSpec, parseOperationArgv } from './cli-adapter.mjs';
import { writeAllSync } from '../lib/write-all-sync.mjs';
import { recordRedTeamRulingEntry } from './record-red-team-ruling-io.mjs';

export function assertJudgeShimOnPath(env, actor) {
  if (actor === 'judge:r10' && !String(env.PATH ?? '').split(delimiter).some(path => path.includes('gh-shim.d'))) {
    throw new Error('App gh shim (gh-shim.d) must be on PATH for judge:r10; prepend ~/.claude/github-app-token/gh-shim.d/<id>');
  }
}

export async function main(argv, { entry = recordRedTeamRulingEntry, stores,
  write = text => writeAllSync(1, text), run = runOperationCli } = {}) {
  try {
    const { declaration, sinks } = entry();
    if (argv.includes('--help')) { write(`${buildCliSpec(declaration).usage}\n`); return 0; }
    const registry = createRegistry();
    registry.register(declaration);
    const input = parseOperationArgv(declaration, argv).input;
    assertJudgeShimOnPath(process.env, argv.includes('--actor=judge:r10') ? 'judge:r10' : input.actor);
    const preview = input.preview === true;
    const outcome = await run({
      declaration, argv, registry, sinks,
      store: stores?.store ?? (preview ? createMemoryRunStore() : createFileRunStore()),
      callLog: stores ? stores.callLog : preview ? undefined : createFileCallLogStore(),
      makeJudge: () => null, // no judge is used; runOperationCli builds one eagerly after the parse
      newRunId: () => newRunId(declaration.name),
    });
    write(`${outcome.lines.join('\n')}\n`);
    return outcome.code;
  } catch (error) {
    write(`error: ${String(error?.message ?? error)}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { writeAllSync(1, `error: ${String(e?.message ?? e)}\n`); process.exit(1); });
}
