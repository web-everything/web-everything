// Run-scoped temp root for every vitest run — see scripts/lib/test-tmp-root.mjs for the leak it stops and
// the WE_TMP_LEAK_* policy knobs. Runs in the main vitest process BEFORE workers spawn; vitest builds the
// worker env from `process.env` at run time, so the TMPDIR set here reaches every worker and spawned child.
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FAKE_GH_DIR_ENV,
  createRunTmpRoot,
  createSharedFakeGh,
  removeSharedDir,
  finishRunTmpRoot,
  resolveTmpLeakPolicy,
  sweepStaleRunRoots,
} from './scripts/lib/test-tmp-root.mjs';

export default function setup() {
  const baseTmp = tmpdir();
  sweepStaleRunRoots({ baseTmp });
  const root = createRunTmpRoot({ baseTmp });
  const saved = {
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
    WE_DAEMON_EVENTS: process.env.WE_DAEMON_EVENTS,
    [FAKE_GH_DIR_ENV]: process.env[FAKE_GH_DIR_ENV],
  };
  process.env.TMPDIR = root;
  process.env.TMP = root;
  process.env.TEMP = root;
  // Child processes and non-sandboxed test tiers must never inherit the operator's event stream.
  process.env.WE_DAEMON_EVENTS = join(root, 'daemon-events.jsonl');
  // One fake `gh` for the whole run (vitest.setup.ts used to write one per test file).
  process.env[FAKE_GH_DIR_ENV] = createSharedFakeGh(root);
  return function teardown() {
    let failed = true;
    try {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      removeSharedDir(root);
      const verdict = finishRunTmpRoot({ root, policy: resolveTmpLeakPolicy() });
      failed = verdict.failed;
    } finally {
      if (failed) {
        process.exitCode = 1;
        // The JSON report precedes teardown. Preserve both cleanup exceptions and leak-policy failures
        // so a passing file retry cannot erase them; exceptions still propagate to Vitest.
        const marker = process.env.WE_TEARDOWN_FAILURE_FILE;
        if (marker) writeFileSync(marker, 'cleanup or tmp-leak policy failed in global teardown\n');
      }
    }
  };
}
