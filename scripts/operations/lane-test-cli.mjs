#!/usr/bin/env node
/** @file scripts/operations/lane-test-cli.mjs
 * @description Standalone declared lane-test entry point. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegistry } from './registry.mjs';
import { runOperationCli } from './cli-adapter.mjs';
import { createMemoryRunStore, createFileRunStore, newRunId } from './run-store.mjs';
import { laneTestOperation, LANE_TEST_EFFECT } from './lane-test.mjs';
import { createLaneTestSinks } from './lane-test-io.mjs';

export async function runLaneTestCli(argv, sinks = createLaneTestSinks(), store = createMemoryRunStore()) {
  const registry = createRegistry(), declaration = registry.register(laneTestOperation());
  const outcome = await runOperationCli({ declaration, registry, argv, sinks,
    store, newRunId: () => newRunId('lane-test') });
  const result = outcome.run?.effects.find(e => e.type === LANE_TEST_EFFECT)?.result;
  if (!result) return { ...outcome, code: outcome.stopped === 'help' ? 0 : 2 };
  const code = result.cleanupError ? 3 : result.signal ? result.exitCode : result.exitCode === 75 ? 75 : result.exitCode === 0 ? 0 : 1;
  const lines = argv.includes('--json') || argv.includes('--json=true') ? [JSON.stringify(result)]
    : [...Object.entries(result).filter(([k]) => k !== 'tail').map(([k, v]) => `${k}: ${JSON.stringify(v)}`),
      ...result.summary.failedFiles.map(p => `FAIL ${p}`), `tail: ${result.tail}`];
  return { code, lines };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLaneTestCli(process.argv.slice(2), createLaneTestSinks(), createFileRunStore()).then(({ code, lines }) => {
    process.stdout.write(`${lines.join('\n')}\n`); process.exitCode = code;
  }).catch(e => { console.error(`refused: ${e.message}`); process.exitCode = 2; });
}
