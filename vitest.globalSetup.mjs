// Run-scoped temp root for every vitest run — see scripts/lib/test-tmp-root.mjs for the leak it stops and
// the WE_TMP_LEAK_* policy knobs. Runs in the main vitest process BEFORE workers spawn; vitest builds the
// worker env from `process.env` at run time, so the TMPDIR set here reaches every worker and spawned child.
import { tmpdir } from 'node:os';
import {
  createRunTmpRoot,
  finishRunTmpRoot,
  resolveTmpLeakPolicy,
  sweepStaleRunRoots,
} from './scripts/lib/test-tmp-root.mjs';

export default function setup() {
  const baseTmp = tmpdir();
  sweepStaleRunRoots({ baseTmp });
  const root = createRunTmpRoot({ baseTmp });
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  process.env.TMPDIR = root;
  process.env.TMP = root;
  process.env.TEMP = root;
  return function teardown() {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const verdict = finishRunTmpRoot({ root, policy: resolveTmpLeakPolicy() });
    if (verdict.failed) process.exitCode = 1;
  };
}
