#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegistry } from './registry.mjs';
import { createMemoryRunStore, newRunId } from './run-store.mjs';
import { runOperationCli, hasJsonFlag } from './cli-adapter.mjs';
import { overlayStatusOperation, overlayStatusLines, OVERLAY_STATUS_FOOTER } from './overlay-status.mjs';
import { collectOverlayStatus } from './overlay-status-io.mjs';
export async function runOverlayStatusCli(argv, { collect = collectOverlayStatus } = {}) {
  const declaration = overlayStatusOperation({ collect });
  const registry = createRegistry();
  registry.register(declaration);
  const outcome = await runOperationCli({ declaration, registry, sinks: {}, store: createMemoryRunStore(), newRunId: () => newRunId(declaration.name),
    argv });
  if (!hasJsonFlag(argv) && outcome.run?.verdict) {
    outcome.lines.unshift(...overlayStatusLines(outcome.run.verdict));
    outcome.lines.push(OVERLAY_STATUS_FOOTER);
  }
  return outcome;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runOverlayStatusCli(process.argv.slice(2)).then(({ code, lines }) => {
    process.stdout.write(`${lines.join('\n')}\n`);
    process.exitCode = code;
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
