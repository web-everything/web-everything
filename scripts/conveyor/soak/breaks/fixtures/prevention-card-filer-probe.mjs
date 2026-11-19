#!/usr/bin/env node
/**
 * @file fixtures/prevention-card-filer-probe.mjs — #4075 soak harness fixture for
 * `breaks/prevention-card-lands-in-daemon-clone.mjs`. Calls the REAL production
 * `fileApprovalPreventionCard` (`scripts/review-set-label.mjs`) from a SEPARATE process whose own cwd IS the
 * checkout under test — never re-implemented, never stubbed on the seam this break exists to prove.
 *
 * On a PRE-#4317 tree, `fileApprovalPreventionCard`'s second argument only destructures `{exec}` — no `root`,
 * no `runScript` — so the two extra flags below are silently ignored there and the call falls straight through
 * to its real default (`execFileSyncThrottled`), shelling `node scripts/operations/run.mjs file-item …` with
 * NO cwd override, inheriting THIS PROCESS's own cwd exactly as production does. On a POST-#4317 tree, those
 * same two flags are honored: `runScript` points at `prevention-card-noop-job.mjs`. On the diagnostic-only
 * spawner, keep the canonical landing target through validation and substitute the no-op only at the OS
 * spawn seam. The real detached primitive still runs and genuinely spawns a child without acquiring a lane.
 *
 * argv: <modulePath> <inputJson> <noopJobPath>
 * Prints the `fileApprovalPreventionCard()` result as one JSON line to stdout.
 */
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const [, , modulePath, inputJson, noopJobPath] = process.argv;

async function main() {
  const mod = await import(pathToFileURL(modulePath).href);
  const input = JSON.parse(inputJson);
  const detached = await import(new URL('./operations/detached-dispatch.mjs', pathToFileURL(modulePath)).href);
  let spawned = 0;
  const opts = { runScript: noopJobPath, logPathFor: () => '/dev/null' };
  if (typeof detached.defaultSpawnDiagnosticDetached === 'function') {
    delete opts.runScript;
    opts.spawnDetached = (argv, options) => detached.defaultSpawnDiagnosticDetached(argv, options, {
      spawn(executable, args, spawnOptions) {
        spawned += 1;
        return spawn(executable, [noopJobPath, ...args.slice(1)], spawnOptions);
      },
    });
  }
  const result = mod.fileApprovalPreventionCard(input, opts);
  if (typeof detached.defaultSpawnDiagnosticDetached === 'function' && result?.ok && spawned !== 1) {
    throw new Error(`expected one diagnostic child spawn, got ${spawned}`);
  }
  return result;
}

main().then(
  (result) => { process.stdout.write(`${JSON.stringify(result ?? null)}\n`); },
  (e) => {
    process.stderr.write(`prevention-card-filer-probe: threw: ${String((e && e.stack) || e)}\n`);
    process.stdout.write('null\n');
    process.exitCode = 1;
  },
);
